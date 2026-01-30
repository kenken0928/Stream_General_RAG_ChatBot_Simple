# Simple RAG Chat  
(Cloudflare Pages + Pages Functions + Cloudflare R2)

本リポジトリは、Cloudflare Pages / Pages Functions / Cloudflare R2 を用いて構築した  
**セッション認証付き・管理画面付き RAG チャット PoC** です。

本プロジェクトの主目的は、以下の 2 点です。

1. **Cloudflare Pages 環境で、安全で再利用可能な認証・ルーティング構造を確立すること**
2. **RAG（Retrieval-Augmented Generation）を、非エンジニアでも運用できる形に落とし込むこと**

本構成は、このアプリ固有に閉じたものではなく、  
**別の PoC / 別プロジェクトでもそのまま流用可能な汎用テンプレート**として設計されています。

---

## 全体構成（アーキテクチャ）

[ Browser ]  
　↓  
[ Cloudflare Pages (public/) ]  
　↓ fetch  
[ Pages Functions (functions/) ]  
　↓  
[ Cookie / Session / R2 ]

設計方針：

- 画面遷移は **middleware で制御**
  - 未認証時は redirect を使用
- 認証・権限判定は **すべて middleware に集約**

- Cloudflare Pages の public 配下 HTML は物理的には取得可能なため、
  「画面表示の可否」はmiddlewareによる制御が前提となります。

- ログアウト後もCookieが残っているとAPIは拒否されるが、ページは表示されるように見えることがある。
  → middleware.jsによるページガードが必須
  
---

## ディレクトリ構成（tree）

```
/
├─ public/
│  ├─ index.html                  # トップ（未ログイン可）
│  │
│  ├─ login/
│  │  └─ index.html               # ユーザーログイン
│  │
│  ├─ chat/
│  │  └─ index.html               # チャット画面（ログイン必須）
│  │
│  ├─ admin/
│  │  ├─ index.html               # 管理画面（adminのみ）
│  │  └─ login/
│  │     └─ index.html            # 管理者ログイン
│  │
│  └─ assets/
│     ├─ style.css                # 共通CSS
│     └─ app.js                   # APIラッパ・共通JS（apiGet/apiPost 等）
│
├─ functions/
│  ├─ _middleware.js              # ★ 認証・rewrite・保守制御の中核
│  ├─ _shared.js                  # Cookie/署名/共通レスポンス/R2ユーティリティ
│  │
│  ├─ api/
│  │  ├─ login.js                 # ユーザーログインAPI
│  │  ├─ logout.js                # ユーザーログアウトAPI
│  │  ├─ session.js               # ユーザーセッション確認API
│  │  ├─ chat.js                  # チャットAPI（RAG + LLM）
│  │  │
│  │  └─ admin/
│  │     ├─ login.js              # 管理者ログインAPI
│  │     ├─ logout.js             # 管理者ログアウトAPI
│  │     ├─ session.js            # 管理者セッション確認API
│  │     ├─ preview.js            # R2内容プレビュー（CSV先頭 / config.json）
│  │     ├─ save.js               # CSV / config をR2へ保存（上書き）
│  │     └─ delete.js             # CSV / config をR2から削除
│  │
└─ README.md
```

---

## ルーティングと認証の考え方

### 基本原則

- URL は **常に trailing slash 付き**で扱う  
  例：  
  `/login/` / `/chat/` / `/admin/` / `/admin/login/`

- `_middleware.js` 冒頭で **URL正規化（末尾スラッシュ統一）** を行う
- 認証が必要な URL は middleware 側で一元管理

### 守られるURL（例）

- `/chat/`  
  - 未ログイン → `/login/` に redirect
- `/admin/`  
  - admin 未ログイン → `/admin/login/` に redirect

UI 側で「ログインしているか」を意識する必要はありません。

---

## セッション管理について

- Cookie ベースの署名付きセッション
- Cookie 名は `_shared.js` に集約
- 有効期限（TTL）は Cloudflare Variables で制御

例：

- `SESSION_MAX_AGE_SEC`（ユーザー）
- `ADMIN_SESSION_TTL_SEC`（管理者）

---

## Cloudflare Pages: Variables / Secrets（必須）

### Secrets（必須）

| Name | 内容 |
|---|---|
| SESSION_SIGNING_SECRET | セッション署名用シークレット（十分長いランダム文字列。最低32文字以上推奨） |
| OPENAI_API_KEY | OpenAI を使うなら必須 |
| GEMINI_API_KEY | Gemini を使うなら必須 |

### Variables（必須）

| Name | 内容 |
|---|---|
| LOGIN_USER | 一般ユーザー用ID |
| LOGIN_PASSWORD | 一般ユーザー用PW |
| ADMIN_ID | 管理者ID |
| ADMIN_PASSWORD | 管理者PW |
| LLM_PROVIDER | `openai` または `gemini`（デフォルト） |
| RAG_CSV_KEY | 例：`rag.csv` |
| R2_CONFIG_KEY | 例：`config.json` |
| SESSION_MAX_AGE_SEC | 例：`86400`（ユーザーセッション） |
| ADMIN_SESSION_TTL_SEC | 例：`3600`（管理者セッション） |
| RL_CHAT_USER_5M | chat：ユーザー単位 5分あたりの上限回数（デフォルト：30） |
| RL_CHAT_USER_1D | chat：ユーザー単位 24時間あたりの上限回数（デフォルト：200） |
| RL_CHAT_IP_5M | chat：IP単位 5分あたりの上限回数（デフォルト：60） |
| RL_CHAT_IP_1D | chat：IP単位 24時間あたりの上限回数（デフォルト：500） |
| RL_ADMIN_WRITE_USER_1M | admin：保存・削除API（ユーザー単位 / 1分）（デフォルト：10） |
| RL_ADMIN_WRITE_USER_1D | admin：保存・削除API（ユーザー単位 / 24時間）（デフォルト：50） |
| RL_ADMIN_PREVIEW_USER_1M | admin：プレビューAPI（ユーザー単位 / 1分）（デフォルト：30） |


### Variables（任意）

| Name | 内容 |
|---|---|
| MAINTENANCE_MODE | `1` でメンテON、それ以外OFF |
| DEBUG | `1` でログ多め、通常 `0` |

---

## R2 Binding

- R2 bucket を Pages Functions に binding
- API からは `env.R2_BUCKET`（プロジェクト側の binding 名に依存）で参照

---

## RAG の基本方針（重要）

本プロジェクトの RAG は、  
**「CSV（または TXT）全文を LLM に丸投げしない」** ことを最重要方針としています。

代わりに、

> **質問に関係ありそうな行だけを抽出し、その抜粋を LLM に渡す**

という **軽量・安定・低コスト**な方式を採用しています。

---

## RAG のデータ形式（重要）

### 現状の前提：1行 = 1チャンク

このPoCのRAGは「厳密なCSV解析」ではなく、**行単位のテキスト集合**として扱います。  
したがって、`rag.csv` の中身は実質的に：

- CSV（1行=1レコード）でもOK
- TXT（1行=1チャンク）でもOK

という運用が可能です。

---

## 現在の RAG 検索方式（詳細）

### ① データの読み込み

- `rag.csv` を R2 から取得
- 改行で分割し、行配列として扱う

---

### ② 質問文の前処理

### 1. 強めの文字正規化（NFKC 正規化）

検索時には、質問文・RAGデータの双方に対して以下の正規化を行います。

- Unicode 正規化（NFKC）
  - 全角／半角の統一
  - 全角記号・半角記号の揺れを吸収
- 全角スペースを半角スペースへ変換
- 各種記号（括弧・句読点・記号類）を空白に置換
- 連続する空白を1つに圧縮

これにより、  
**表記揺れ・全角半角差異・記号の有無による検索漏れを抑制**しています。

---

### 2. 日本語を想定した簡易キーワード抽出

英語のようなスペース区切りが効きにくい日本語向けに、  
形態素解析を使わず、以下の方法でキーワードを抽出します。

- 助詞や文法語で分割  
  （例：の / が / は / を / に / で / と / です / ます など）
- 「漢字・ひらがな・カタカナ・英数字」の連続列を正規表現で追加抽出
- 2文字以上の語のみを採用
- 複合語を優先するため、文字数が長い語を優先的に使用

これにより、  
「切断不良」「接着不良」「温度設定」などの **日本語特有の複合語**を拾いやすくしています。

---

### 3. 2文字 n-gram（bigram）による補助スコアリング

単語一致だけでは拾えない表記揺れ対策として、  
**2文字 n-gram（bigram）の Jaccard 類似度**を補助的に使用しています。

- 例：「切断不良」⇔「切断が不良」
- 例：「フィルム方向」⇔「フィルムの向き」

bigram 類似は主役ではなく **補助的なスコア**として加算し、  
意味的な誤ヒットが増えないよう重みは控えめに設定しています。


---

### ③ 行単位のスコアリング（工夫の核心）

各 RAG 行に対して、以下のルールでスコアを付与します。

#### A. 質問文全体が行に含まれている場合
- 強い加点（優先度が最も高い）

#### B. 質問文をスペースで分割した単語が含まれている場合
- 単語1つにつき加点
- 含まれる単語が多い行ほどスコアが高くなる

#### C. bigram 類似度の適用
- 補助的に加点

> この方式により、  
> **質問文と関係の薄い行は自然に下位へ落ちる** 仕組みになっています。

---

### ④ 上位行のみを抽出

- スコア順に並べ替え
- **上位 N 行（例：最大20行）のみ**を採用
- スコアが低い行は LLM に渡されない
- **スコアが 0 の行は原則除外**（無関係な行の混入防止）
- ただし、該当行が 0 件の場合は上位行でフォールバック

とすることで、  
**「無関係な情報だらけになる」ことと「何も渡らない」事故の両方を防止**しています。

---

### ⑤ LLM への入力

LLM には以下のみを渡します。

- System Prompt（役割・制約）
- ユーザーの質問
- **関連度が高いと判断された RAG 行の抜粋**

👉  
**CSV 全文を渡すことはありません。**

---

## この方式の評価（現状）

### 良い点

- 処理が軽い・速い
- トークン消費が抑えられる
- Workers 環境で確実に動作
- 数百〜数千行規模の RAG に強い
- 管理画面から即時差し替え可能

### 限界点（認識済み）

- 言い換え表現への耐性は高くない
- 抽象度の高い質問は拾いにくい
- ベクトル検索（Embedding）は未使用

本 PoC では、  
**「まず安全に動く RAG」を優先**し、  
複雑な検索は意図的に採用していません。

## なぜこの方式を採用しているか

- ベクトル検索は構成・運用が重くなりがち
- PoC / 初期運用では「安定性・可視性」が重要
- RAG の中身を **人間が理解できる形**で保つため

この設計により、

- RAG の内容がブラックボックス化しない
- 管理画面での運用ミスが起きにくい
- 後から検索方式を進化させやすい

というメリットがあります。

- 現在の RAG は **全文投げではない**
- 行単位での簡易検索・スコアリングがすでに実装されている
- PoC / 初期運用としては十分実用的
- 構成を壊さず、将来の高度化も可能

---

## 管理画面（/admin/）でできること

管理画面は **4つの領域を独立して保存・削除**できる設計です。  
「保存」した瞬間から、**次のチャットから即反映**されます。

### ① RAG（CSV / TXT）

- **CSV/TXTファイルのアップロード**（`.csv` / `.txt` を選択 → CSV欄へ読み込み）
- **CSVを保存**（R2上の `rag.csv` を上書き保存）
- **CSVを削除**（R2上の `rag.csv` を削除）
- **TXT貼り付け専用エリア**（PDFから抽出したテキスト向け）
  - テキストを貼り付け
  - **「整形してCSV欄へ」** を押すと、RAGに向いた形式へ変換

#### 「整形」の仕様（1段落=1行）

- 空行（2行以上の連続）で区切られた塊を **1段落**として扱う
- 段落内の改行はスペースにまとめ、**1行=1チャンク**へ変換
- 空行がほとんど無いテキストの場合は、**1行=1チャンク**として扱う

> 推奨：RAG精度を上げるため、可能なら行頭に `p=ページ番号` や `見出し` を入れる運用にすると強いです。  
> 例：`[p=12][休職] 休職期間は…`

---

### ② LLM設定（OpenAI / Gemini / モデル名）

- プロバイダ選択（OpenAI / Gemini）
- OpenAIモデル名 / Geminiモデル名を入力
- **LLM設定を保存**（`config.json` の `llm` 部分だけ更新して保存）
- **LLM設定を初期化**（`config.json` から `llm` を削除して保存）

---

### ③ プロンプト設定（用途ごとに変更）

- Systemプロンプト（役割・口調・禁止事項など）を入力
- 回答ルール（1行1ルール）を入力
- **プロンプトを保存**（`config.json` の `prompt` 部分だけ更新して保存）
- **プロンプトを削除**（`config.json` から `prompt` を削除して保存）

---

### ④ 上級者向け：config.json 直接編集

- `config.json` を直接編集して保存
- `config.json` 自体を削除

※ここは全体設定を直接触るため、JSONが壊れると動作に影響が出ます。通常は②③で十分です。

---

## config.json の形式（例）

管理画面②③で保存される想定の形です。

```json
{
  "llm": {
    "provider": "openai",
    "openaiModel": "gpt-4o-mini",
    "geminiModel": "gemini-1.5-flash"
  },
  "prompt": {
    "system": "あなたは社内ヘルプデスクです。根拠のない推測はせず、不明な場合は不明と言ってください。",
    "rules": [
      "可能なら箇条書きで答える",
      "根拠となる行があれば言及する"
    ]
  }
}
```

---

## PDF をRAGに使いたい場合（現実的な運用）

このPoCは「PDFを直接アップロードして解析」は行いません。  
代わりに、**PDFをローカルでテキスト化して取り込む**運用を推奨します。

### 推奨ワークフロー（壊れにくい）

1. 自分のPCで PDF をテキスト化（抽出）
2. 抽出テキストを管理画面の **TXT貼り付け**へ貼る（または `.txt` を選択）
3. **「整形してCSV欄へ」** → **「CSVを保存」**

### 文字コード（Mac / Windows 混在）について

- 管理画面はブラウザの `File.text()` で読み込むため、一般的な環境では  
  **Windowsの CP932 / Shift-JIS 系でも、読み込み時に吸収されて扱えるケースが多い**です。
- ただし、元テキストが破損していたり、抽出結果が崩れている場合は文字化けします。  
  → 管理画面のテキスト欄に表示された内容を目視確認し、問題があれば抽出方法を見直してください。

---

## リダイレクトループに関する留意点

- redirect と rewrite を混在させるとループしやすい
- trailing slash の揺れは致命的
- Cloudflare 側の暗黙 redirect に依存しない設計が重要

→  
**middleware で URL を正規化し、未認証時は明示的に redirect を行うことで安定動作を実現**

---

## 再利用について（重要）

本リポジトリの構成は、以下の用途でそのまま再利用可能です。

- 別の Cloudflare Pages アプリ
- PoC / 管理画面付きツール
- 内部ツール / 社内ダッシュボード

やることは：

1. public 配下の HTML / UI を差し替える
2. 守りたい URL を `_middleware.js` に追加する
3. Cookie 名・TTL を必要に応じて変更する
4. RAGデータ（`rag.csv`）と設定（`config.json`）の運用だけ決める

**認証・セッション・ルーティングの骨格はそのまま使えます。**

---

## レート制限（Rate Limiting）について

本アプリでは、**不正利用・過剰アクセス・コスト暴走防止**のため、  
Cloudflare Pages Functions + Cloudflare KV を用いた **アプリケーションレベルのレート制限**を実装しています。

レート制限の判定は **functions/_middleware.js** に集約されており、  
UI / API 各実装側で個別に意識する必要はありません。

---

## Cloudflare KV の設定（必須）

### 1. KV Namespace の作成

Cloudflare Dashboard から、レート制限用の KV Namespace を作成します。

- Cloudflare Dashboard  
  → Workers & Pages  
  → KV  
  → **Create namespace**

**例：**

| 項目 | 値 |
|---|---|
| Namespace name | `simple-rag-ratelimit` |

---

### 2. Pages プロジェクトへの Binding

作成した KV Namespace を、対象の Pages プロジェクトに Binding します。

- Workers & Pages  
  → 対象の Pages プロジェクト  
  → Settings  
  → Bindings  
  → **KV Namespace**

| 項目 | 値 |
|---|---|
| Variable name | `RATELIMIT` |
| KV Namespace | `simple-rag-ratelimit` |

コード側では、この KV を **`env.RATELIMIT`** として参照します。

---

## Cloudflare Pages: Variables and Secrets（レート制限用）

レート制限の数値は **環境変数で上書き可能**な設計になっています。  
これにより、**コードを変更せずに制限値を調整**できます。

> 数値情報のため、すべて **Variables**（Secrets ではない）で設定します。

---

### chat（一般ユーザー）用

| Variable 名 | 内容 | デフォルト値 |
|---|---|---|
| `RL_CHAT_USER_5M` | ユーザー単位：5分あたりの上限 | `30` |
| `RL_CHAT_USER_1D` | ユーザー単位：24時間あたりの上限 | `200` |
| `RL_CHAT_IP_5M` | IP単位：5分あたりの上限 | `60` |
| `RL_CHAT_IP_1D` | IP単位：24時間あたりの上限 | `500` |

---

### admin（管理画面）用

| Variable 名 | 内容 | デフォルト値 |
|---|---|---|
| `RL_ADMIN_WRITE_USER_1M` | 管理者：保存/削除系API（1分） | `10` |
| `RL_ADMIN_WRITE_USER_1D` | 管理者：保存/削除系API（24時間） | `50` |
| `RL_ADMIN_PREVIEW_USER_1M` | 管理者：プレビュー閲覧（1分） | `30` |

※ 環境変数が未設定の場合は、コード内のデフォルト値が使用されます。

---

## レート制限の適用対象と条件

### 一般ユーザー（/api/chat）

以下 **すべての条件を同時に満たす必要があります**  
（どれか1つでも超えると 429 が返ります）

| 種類 | キー | 制限 |
|---|---|---|
| ユーザー | `chat:u:<user>` | 30回 / 5分 |
| ユーザー | `chat:u:<user>:day` | 200回 / 24時間 |
| IP | `chat:ip:<ip>` | 60回 / 5分 |
| IP | `chat:ip:<ip>:day` | 500回 / 24時間 |

---

### 管理画面 API（/api/admin/*）

| API | 制限内容 |
|---|---|
| preview | 管理者ユーザー単位：30回 / 1分 |
| save / delete | 管理者ユーザー単位：10回 / 1分 |
| save / delete | 管理者ユーザー単位：50回 / 24時間 |

---

## 実装上の注意点

- レート制限は **Pages Functions の middleware 層で実施**
- UI / API 側では特別な処理は不要
- 超過時は **HTTP 429 (Too Many Requests)** を返却
- `Retry-After` ヘッダを付与

---

## 運用上の考え方（重要）

- レート制限は **セキュリティ・コスト保護のための保険**
- 小規模・PoC・学習用途では、数値を大きめに緩和しても問題ありません
- 公開・不特定多数利用を想定する場合は、必ず有効化してください
- 数値は **Cloudflare Pages の Variables 変更のみで調整可能**です

---

## 補足：本番 / Preview 環境について

Cloudflare Pages では、  
Production 環境と Preview 環境が自動的に分かれます。

- 本番と Preview で完全に分離したい場合は、  
  **環境ごとに別の KV Namespace を Binding**してください。
- 小規模運用では、同一 KV を使っても動作自体に問題はありません。

---


## まとめ

- 本プロジェクトは「RAGチャット」以上に  
  **Cloudflare Pages における実践的な認証テンプレ**として再利用できる
- 管理画面から、RAG/LLM/プロンプトを分離して安全に運用可能
- PDFは「ローカルでテキスト化 → TXT貼り付け/アップロード」で、複雑化せずに実運用できる

この README 自体も、テンプレとしてコピーして使って問題ありません。
