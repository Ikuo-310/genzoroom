# LightCraft Engine API調査

収録日：2026-10-20。基準：LightCraft v0.9.1 / `4f0b110bcbd2e350c6d97b47f1d824c2222295c4`。
元資料と証拠区分は[資料索引](README.md)を参照。以下の元資料由来の節番号・ソース行番号は元調査のものを維持している。

本書はソースで確認されたAPIと制約を扱う。「実装済み」はLightCraft側コードの存在を指し、GenzoRoom統合の動作確認を意味しない。本文の推奨・設計選択は提案であり、性能・画素一致・将来互換性は未検証。

## 2. CLIの実行モデル

**実装済み：単発実行と、セッションを保持する常駐実行の両方がある。**

| 起動方式 | セッションの寿命 | 対話編集への適性 |
|---|---|---|
| `lightcraft-cli render …` | 起動ごとに作成・終了 | バッチ処理向け |
| `lightcraft-cli run …` | 指定した一連のコマンド中のみ保持 | 固定スクリプト向け |
| `lightcraft-cli mcp` | stdio接続中、同じ`Session`を保持 | 既存機能での統合候補 |
| GUIの`--control PORT` | GUIプロセス中保持 | GUI起動が必要 |

### 2.1 単発render

`render()`は`Session::new().with_fs()`を作成し、Import→Select→設定適用→Exportを実行する。起動ごとに終了するため、次のプロセスへデコード済み画像を引き継ぐ仕組みではない。

- `--set control=value`：個別controlの設定。
- `--settings FILE`：部分DevelopSettings JSON、または対応するpresetの適用。
- `--size`など：Exportの出力条件。
- 調査した実装では`with_default_denoise_models()`と`with_system_clock()`も設定している。

根拠：[apps/lightcraft-cli/src/main.rs:668](/I:/code/lightcraft/apps/lightcraft-cli/src/main.rs:668) `render()`。

### 2.2 runとstdin

`run`では複数コマンドを同じSessionで実行できる。コマンドID、JSONパラメータ、制御プロトコルのmethodを扱う。

ただし、`run --script -`はstdinを`read_to_string()`でEOFまで読み、その後にコマンド列を実行する。stdinへ指示を逐次送って応答を受ける対話サーバーではない。

出力はコマンドごとのJSON行で、結果、成功／失敗、実行時間などを含む。指定されたコマンド列を実行した後、backendを破棄する。

根拠：[main.rs:490](/I:/code/lightcraft/apps/lightcraft-cli/src/main.rs:490) `Step`周辺、[main.rs:552](/I:/code/lightcraft/apps/lightcraft-cli/src/main.rs:552)、[main.rs:580](/I:/code/lightcraft/apps/lightcraft-cli/src/main.rs:580)。関連関数：`parse_steps()`、`run_step()`、`run()`。

### 2.3 常駐headless MCP

`lightcraft-cli mcp`は、ウィンドウなしでEngineの`Session`を保持する。

- stdin/stdout：改行区切りJSON-RPC 2.0。
- stdout：プロトコル応答。
- stderr：ログ。
- `tools/call`から`command_run`、`render_preview`、Exportなどを呼び出せる。
- `--library`省略時はメモリ内Session。永続ライブラリは必須ではない。
- `--library DIR`で永続ライブラリを利用できる。同じライブラリを別プロセスが開いている場合はロック制約がある。
- `--compact`でhelper tool中心の公開にできる。
- Pythonから通常のプロトコルクライアントとして利用でき、AIモデルやLLMを介する必要はない。
- `Headless`は`pub session: Session`を所有する。
- `Headless::default()`はfilesystem hookなどを設定し、Dropでは永続ライブラリの終了処理を行う。

根拠：[crates/mcp/src/headless.rs:14](/I:/code/lightcraft/crates/mcp/src/headless.rs:14) `Headless`、[crates/mcp/src/progress.rs:48](/I:/code/lightcraft/crates/mcp/src/progress.rs:48) `serve_stdio()`、[apps/lightcraft-cli/src/main.rs:368](/I:/code/lightcraft/apps/lightcraft-cli/src/main.rs:368)、[docs/mcp.md](/I:/code/lightcraft/docs/mcp.md)。

MCPの主要な関連API／tool：

| 名前 | 用途 |
|---|---|
| `command_list` | コマンド一覧取得 |
| `command_run` | コマンドIDとparamsによる実行 |
| `command_batch` | 一連のコマンド実行。個々の編集は別Undoになり得る |
| `doc_inspect` | ライブラリ状態取得 |
| `import` | ファイル／フォルダ登録 |
| `render_preview` | `id?`、`max_side?`、`format?`で画像取得 |
| `render_photo` | `size`など既存の引数体系で画像取得 |
| `app.export` | headless backendが処理するExportコマンド |

`command_run`からEngineへは、backendの`engine.execute`を経由する。MCPと後述のGUI用独自JSON-linesプロトコルを混同しないこと。

### 2.4 GUIの制御チャネル

GUIには`lightcraft --control PORT`で起動するloopback TCPの独自JSON-lines制御がある。例えば`engine.execute`にcommandとparamsを渡す。MCPとは異なるワイヤー形式である。

GUIのフレーム処理に依存し、要求はUIスレッドでフレーム間に処理される。ウィンドウが描画されない状況のタイムアウトも文書化されている。GenzoRoomのバックエンド用途ではheadless MCPの方が単純である、というのが設計上の推奨。

根拠：[docs/control-protocol.md:3](/I:/code/lightcraft/docs/control-protocol.md:3)、[apps/lightcraft/src/control_server.rs](/I:/code/lightcraft/apps/lightcraft/src/control_server.rs)。

`denoise-serve`も存在するが、AI Denoise用のremote serverであり、汎用RAW編集セッション用サーバーとして扱うものではない。

根拠：[main.rs:981](/I:/code/lightcraft/apps/lightcraft-cli/src/main.rs:981)。

## 3. Engine APIとセッション管理

### 3.1 GUIのRAW読込からプレビューまで

RAWを開いて編集プレビューを表示する主要経路は以下のとおり。

```text
Session::execute("library.import", …)
  → カタログへ写真登録
  → library.select
  → detail::show()
  → Session::loupe_job()
  → Session::render_job() / build_job()
  → MediaCache::source_ref()
  → Renderer::request()
      request_idとStageCacheを付与
  → JobPoolのワーカースレッド
  → RenderJob::run()
      未キャッシュならSourceRef::load_source()
        → with_fs()が設定したFileLoader
        → files::load_vec()
        → RAW decode、縮小現像、色変換
      → develop_reporting()
      → GPUまたはCPU pipeline
  → Renderer::poll()
  → Session::accept()
  → eguiテクスチャとして表示
```

写真の登録と、実際の表示用ソースの読込・現像は分けて考える必要がある。未キャッシュのソースはレンダージョブのワーカー側で読み込まれる。

根拠：

- [crates/ui-egui/src/panels/detail.rs:436](/I:/code/lightcraft/crates/ui-egui/src/panels/detail.rs:436) `show()`。
- [detail.rs:571](/I:/code/lightcraft/crates/ui-egui/src/panels/detail.rs:571)：loupeジョブ要求、操作中の`draft()`切替。
- [crates/ui-egui/src/render.rs:452](/I:/code/lightcraft/crates/ui-egui/src/render.rs:452) `Renderer::request()`。
- [crates/engine/src/media.rs:1196](/I:/code/lightcraft/crates/engine/src/media.rs:1196) `render_job()`、`build_job()`。
- [media.rs:872](/I:/code/lightcraft/crates/engine/src/media.rs:872) `RenderJob::run()`。
- [crates/engine/src/files.rs:1061](/I:/code/lightcraft/crates/engine/src/files.rs:1061) `fs_hooks()`。
- [render.rs:721](/I:/code/lightcraft/crates/ui-egui/src/render.rs:721) `Renderer::poll()`。

### 3.2 Sessionの再利用可能性

**実装済み：GUIなしで再利用できる。**

`Session`、`media`、`pipeline`、`develop`は公開APIとして利用できる。専用Rustプロセスでは以下の既存APIが候補になる。

| API | 用途 |
|---|---|
| `Session::new()` | メモリ内Session作成 |
| `Session::with_fs()` | FileLoader、FileProbe、埋込Preview loaderなどを設定 |
| `Session::execute()` | Engineコマンド実行 |
| `Session::develop_of()` | 設定の`Arc<DevelopSettings>`取得 |
| `Session::set_develop()` | 設定全体変更、履歴・interactionに対応 |
| `Session::render_now()` | 同期レンダリング |
| `Session::render_job()` | 非同期実行可能なジョブ作成 |
| `Session::preview_job()` | 一時設定によるプレビュー |
| `Session::accept()` | ジョブが読み込んだソースをSession側キャッシュへ受入れ |
| `Session::export_job()` | Export用ジョブ作成 |
| `export::export_photo()`／`prepare_batch()` | 共通Export経路 |

根拠：[crates/engine/src/lib.rs:56](/I:/code/lightcraft/crates/engine/src/lib.rs:56)、[lib.rs:93](/I:/code/lightcraft/crates/engine/src/lib.rs:93)、[lib.rs:408](/I:/code/lightcraft/crates/engine/src/lib.rs:408)、[lib.rs:515](/I:/code/lightcraft/crates/engine/src/lib.rs:515)、[files.rs:1095](/I:/code/lightcraft/crates/engine/src/files.rs:1095)。

**未確認：** 公開Rust APIが将来も互換性を維持するという保証。commitを固定して扱うのが妥当である。

### 3.3 データの保持と破棄

| データ | 実装上の保持方法 |
|---|---|
| RAWファイルの圧縮バイト列・センサーサンプル | 通常の読込完了後は解放 |
| 現像用ソース | 線形Rec.2020の`Arc<Rgb32f>`と`SourceInfo`を保持 |
| ソースの解像度別キャッシュ | Thumb、Preview、Full |
| 中間処理結果 | 呼出側が保持する`StageCache` |
| 完成Preview | `PreviewCache`。メモリと、ライブラリ使用時のディスクキャッシュ |

`SourceLevel`：

- `Thumb`：長辺512px。
- `Preview`：長辺2560px。
- `Full`：原寸。
- `for_size()`は要求サイズに応じてレベルを選択する。
- Previewは既定で最大4件、Fullは通常1件を保持し、メモリ予算でも退避される。
- `MediaCache::set_on_screen()`には、表示中写真の原寸ソースが予算超過だけで追い出されないようにする経路がある。

重要なのは、RAWセンサー配列をずっと保持する構造ではなく、再編集用の線形RGBソースを保持する構造であること。PreviewからFullへ移るときや、ソースが退避されていた場合には再デコードが発生し得る。

`files::load_bytes_now()`はRAWデコード後に縮小向けのmosaic binning、またはdemosaicを行い、色変換などを経てpipeline用のソースを生成する。低解像度Previewは単に原寸完成画像を毎回縮小するだけの経路ではない。

根拠：[media.rs:87](/I:/code/lightcraft/crates/engine/src/media.rs:87)、[media.rs:177](/I:/code/lightcraft/crates/engine/src/media.rs:177) `DecodedSource`周辺、[media.rs:335](/I:/code/lightcraft/crates/engine/src/media.rs:335) `MediaCache`、[files.rs:407](/I:/code/lightcraft/crates/engine/src/files.rs:407) `load_bytes_now()`。

関連する管理API：

- `MediaCache::clear_sources()`：デコード済みソースを破棄。
- `MediaCache::forget(id)`：写真単位の破棄。
- `MediaCache::set_budget(bytes)`／`budget()`／`held()`：メモリ予算・使用量。
- `MediaCache::set_full_capacity(n)`：原寸ソース保持数。
- `MediaCache::preview_capacity`：Preview保持数。
- `MediaCache::set_disk_cache_bytes()`：ディスクPreviewキャッシュ予算。
- `StageCache::clear()`／`bytes()`：段階キャッシュ管理。

キャッシュから除去しても、実行中ジョブなどが`Arc`を保持していれば、その時点で全メモリが即座に解放されるとは限らない。

根拠：[media.rs:458](/I:/code/lightcraft/crates/engine/src/media.rs:458)、[media.rs:466](/I:/code/lightcraft/crates/engine/src/media.rs:466)、[media.rs:505](/I:/code/lightcraft/crates/engine/src/media.rs:505)、[media.rs:614](/I:/code/lightcraft/crates/engine/src/media.rs:614)、[crates/pipeline/src/lib.rs:262](/I:/code/lightcraft/crates/pipeline/src/lib.rs:262)。

## 4. プレビュー生成

### 4.1 既存API

**実装済み：**

| API | 内容 |
|---|---|
| `render_now(id, width, height)` | 同期レンダリング。実行後に`accept()`する |
| `render_job()` | 別スレッドで実行できるジョブ作成 |
| `loupe_job()` | Full品質の完成結果を表示用キャッシュにも保存 |
| `preview_job()` | 指定設定での一時プレビュー |
| `region_job()` | 拡大表示の領域レンダリング |
| `RenderJob::draft()` | 操作中のDraft品質 |
| `RenderJob::with_stages()` | 中間処理結果の再利用 |
| `quick_view_job()` | キャッシュ画像、埋込JPEG、縮小現像などの暫定表示 |
| MCP `render_preview` | 既定1024px、16〜4096pxに制限 |

根拠：[media.rs:790](/I:/code/lightcraft/crates/engine/src/media.rs:790) `draft()`周辺、[media.rs:847](/I:/code/lightcraft/crates/engine/src/media.rs:847) `with_stages()`、[media.rs:1274](/I:/code/lightcraft/crates/engine/src/media.rs:1274) `preview_job()`、[media.rs:1415](/I:/code/lightcraft/crates/engine/src/media.rs:1415) `loupe_job()`周辺、[media.rs:1581](/I:/code/lightcraft/crates/engine/src/media.rs:1581) `render_now()`、[crates/mcp/src/tools.rs:502](/I:/code/lightcraft/crates/mcp/src/tools.rs:502) `render_photo()`。

MCP `render_preview`は`max_side`を内部の`size`へ変換して`render_photo()`を使う。

根拠：[tools.rs:620](/I:/code/lightcraft/crates/mcp/src/tools.rs:620)。

出力が小さくても、強いクロップにより必要なソース解像度が上がればFullを選ぶ場合がある。「常にPreviewレベルだけで処理する」という契約ではない。

根拠：[media.rs:1218](/I:/code/lightcraft/crates/engine/src/media.rs:1218) `build_job()`のsource level選択、`source_edge_needed()`。

### 4.2 パラメータ変更時の再利用と再計算

| 変更 | 再利用／再計算 |
|---|---|
| 露光量、トーン、色のスライダー | 同じソースと段階キャッシュを使い、主にピクセル処理を再実行 |
| WB、NR、修復など | 依存する線形処理・中間結果を再計算 |
| クロップ、回転、レンズ補正、出力サイズ | 幾何変換・再サンプリングなどを再計算 |
| ソース解像度の切替、退避済みソースへのアクセス | 読込・RAW現像が再発生し得る |

pipelineはgeometry、scene-linear、tone、colour、displayなどの処理を持つ。露光をgainとして扱い、変更された入力に応じて段階キャッシュを使い分ける。厳密な再利用条件は設定・source・要求サイズなどのキーによる。

根拠：[pipeline/lib.rs:1](/I:/code/lightcraft/crates/pipeline/src/lib.rs:1)、[pipeline/lib.rs:17](/I:/code/lightcraft/crates/pipeline/src/lib.rs:17)、[pipeline/lib.rs:395](/I:/code/lightcraft/crates/pipeline/src/lib.rs:395) `plan()`、[pipeline/lib.rs:529](/I:/code/lightcraft/crates/pipeline/src/lib.rs:529) `render_cached()`。

**既存MCPの制約：** `Headless::render()`は`render_now()`を使う。ソースキャッシュは再利用するが、ジョブの`stages`は初期値`None`であり、GUIのように`StageCache`を継続保持しない。

根拠：[headless.rs:55](/I:/code/lightcraft/crates/mcp/src/headless.rs:55)、[media.rs:1264](/I:/code/lightcraft/crates/engine/src/media.rs:1264)、[media.rs:1581](/I:/code/lightcraft/crates/engine/src/media.rs:1581)。

### 4.3 GenzoRoomへの画像受渡し

**既存MCPで実装済み：**

`render_preview`は一時PNGを生成し、読み戻して削除し、MCPのimage contentとしてBase64で返す。画像contentには`mimeType`、別のtext contentには寸法などのmetadataが入る。JPEG指定時はPNGの再デコード・JPEG再エンコードも入る。

`Headless::call("ui.render", …)`自体は、path指定時に画像を書いてpath・寸法を返す。pathなしでは寸法だけを返し、画素を直接返すものではない。MCP tool側が一時ファイルと画像contentへの変換を担当する。

根拠：[headless.rs:161](/I:/code/lightcraft/crates/mcp/src/headless.rs:161) `ui.render`分岐周辺、[tools.rs:442](/I:/code/lightcraft/crates/mcp/src/tools.rs:442) `image_result()`、[tools.rs:502](/I:/code/lightcraft/crates/mcp/src/tools.rs:502) `render_photo()`。

**専用Adapterで対応可能：**

`Rendered.image`の`Rgba8`を受け取り、PNG/JPEGのメモリ内エンコード、画像ファイル、独自バイナリIPCなどで返せる。Engineの画像返却自体に一時PNGは必須ではない。共通encoderには`export::encode_image()`がある。

WebView2への表示は、GenzoRoomの既存画像配信方式に合わせる設計事項。Base64画像の受渡し、ファイル配信、バイナリ経路のどれを使うかは今回未決定で、実接続も未確認。

### 4.4 CPU固定

**実装済み：** 子プロセスの環境変数`LIGHTCRAFT_GPU=0`でGPUレンダリングを禁止できる。Rust側には`lightcraft_engine::gpu::set_enabled(false)`もある。GPU利用不可・無効時はCPU reference pipelineを利用する。

根拠：[crates/gpu/src/lib.rs:197](/I:/code/lightcraft/crates/gpu/src/lib.rs:197)、[media.rs:1015](/I:/code/lightcraft/crates/engine/src/media.rs:1015) `develop()`、`develop_reporting()`、`develop_image()`。

CPU固定時の対話プレビュー速度は今回未測定。GPUを無効にできることと、必要な応答時間を満たすことは別である。

### 4.5 非同期処理、キャンセル、古い結果

| 項目 | 状態・内容 |
|---|---|
| Engineジョブの非同期実行 | **実装済み**。`RenderJob`をワーカーへ渡せる |
| GUIの未開始ジョブ集約 | **実装済み**。同じslotの古い未開始要求を新要求で置換 |
| 古い結果の識別 | **実装済み**。`request_id`、写真ID、レンダーキーなどを使用 |
| 単一RAWデコード／レンダリングの任意途中中断 | **確認した経路にはAPIなし** |
| MCPプレビューの要求集約・途中キャンセル | **未実装**。backend callは順番に処理 |
| MCP Exportのキャンセル | **実装済み**だが写真境界。単一Previewの途中停止とは異なる |

根拠：[crates/preview/src/pool.rs:1](/I:/code/lightcraft/crates/preview/src/pool.rs:1)、[pool.rs:182](/I:/code/lightcraft/crates/preview/src/pool.rs:182) `submit()`、[media.rs:733](/I:/code/lightcraft/crates/engine/src/media.rs:733) `RenderJob`、[crates/mcp/src/progress.rs:1](/I:/code/lightcraft/crates/mcp/src/progress.rs:1)、`progress_hook()`。

GUIの`Renderer::poll()`は、古い要求の結果を一律に捨てるだけではない。操作中の表示停滞を避けるため、最新要求ではなくても現在の表示より新しい成功結果なら受け入れる場合がある。これにより、そのジョブが読み込んだソースもキャッシュへ入れられる。

GenzoRoomで「最新revisionだけ表示する」方式を採るか、「現在表示より新しければ暫定表示する」方式を採るかは設計上選べる。いずれも写真切替後の結果混入を防ぐ識別が必要。

根拠：[crates/ui-egui/src/render.rs:785](/I:/code/lightcraft/crates/ui-egui/src/render.rs:785)。

## 5. DevelopSettings

### 5.1 外部設定API

**実装済み：**

| API／コマンド | 用途 |
|---|---|
| `develop.controls` | control ID、範囲、既定値、現在値の取得 |
| `develop.get` | 写真の設定取得 |
| `develop.set` | 単一control、または複数`values`の変更 |
| `develop.adjust` | control値の相対変更 |
| `develop.merge` | 部分JSONの適用 |
| `Session::set_develop()` | Rust側から設定全体を適用 |
| `DevelopSettings::to_json()`／`from_json()` | JSON変換 |
| `DevelopSettings::merged()` | 部分JSONマージ |
| `DevelopSettings::hash64()` | 設定のキャッシュ用ハッシュ |

根拠：[crates/engine/src/cmd/query.rs:170](/I:/code/lightcraft/crates/engine/src/cmd/query.rs:170)、[query.rs:183](/I:/code/lightcraft/crates/engine/src/cmd/query.rs:183)、[crates/engine/src/cmd/develop.rs:159](/I:/code/lightcraft/crates/engine/src/cmd/develop.rs:159)、[develop.rs:248](/I:/code/lightcraft/crates/engine/src/cmd/develop.rs:248)、[crates/engine/src/lib.rs:877](/I:/code/lightcraft/crates/engine/src/lib.rs:877)、[crates/develop/src/lib.rs:34](/I:/code/lightcraft/crates/develop/src/lib.rs:34)。

`develop.set`のparams例：

```json
{"values":{"light.exposure":1.0}}
```

`develop.merge`のparams例：

```json
{"settings":{"light":{"exposure":1.0}},"label":"Exposure"}
```

多くの編集はactive photoに作用する。コマンドによっては`ids`指定を受けるが、すべてのコマンドで任意の写真IDを同じ形で指定できると仮定しないこと。最小PoCでは対象を明示選択し、写真IDを保持する。

### 5.2 部分JSONの意味と注意点

`DevelopSettings::merged()`は`presets::deep_merge()`でオブジェクトを再帰マージし、その結果を設定として読み直す。

- 未指定フィールドは保持。
- オブジェクト同士は再帰マージ。
- 配列は配列全体を置換。
- その他の値は置換。
- `null`をフィールド削除として扱うJSON Merge Patchではない。
- 未知フィールドはserde読込時に無視。
- 型不一致などはエラーになり得る。
- `develop.set`と同等のcontrol検証を、すべての任意JSONへ適用する仕組みではない。

特にWBの`temp`／`tint`を部分JSONで変更し、`scale`を省略すると、互換性のため`Legacy`スケールになる。**WBはcontrol APIを優先し、JSONを使うならscaleも保存・指定することを推奨する。**

根拠：[crates/develop/src/lib.rs:41](/I:/code/lightcraft/crates/develop/src/lib.rs:41) `merged()`、[crates/develop/src/presets.rs:141](/I:/code/lightcraft/crates/develop/src/presets.rs:141) `deep_merge()`、[crates/develop/src/settings.rs:1](/I:/code/lightcraft/crates/develop/src/settings.rs:1)。

### 5.3 操作単位と履歴

`develop.beginInteraction`→複数回変更→`develop.endInteraction`により、ドラッグ全体を1回のUndoへまとめられる。

- interaction中の`set_develop()`は変更を表示用に適用するが、その都度Undo stepを作らない。
- `endInteraction`は最終値を1回の編集として確定する。
- `cancelInteraction`は開始時の設定へ戻す。
- 設定編集の取り消しであり、実行中の計算ジョブを停止するキャンセルではない。

根拠：[crates/engine/src/cmd/develop.rs:1135](/I:/code/lightcraft/crates/engine/src/cmd/develop.rs:1135)、[crates/engine/src/lib.rs:877](/I:/code/lightcraft/crates/engine/src/lib.rs:877)、[lib.rs:936](/I:/code/lightcraft/crates/engine/src/lib.rs:936)。

### 5.4 Process Version

**実装済み：**

- 構造の`version`は`SCHEMA_VERSION = 1`。
- 描画プロセスの`process`は別フィールド。
- 実装するprocessはV1・V2。
- 新規設定の既定はV2（`ProcessVersion::LATEST`）。
- 保存データで`process`欠落・不正値ならV1。
- V1は通常の保存JSONでは省略される。
- 将来のprocess番号は値を保持し、この版で理解できる最新processへフォールバックして描画。
- `develop.get`はV1も含め`process`を明示して返す。
- 全体Resetは最新processを設定する。セクション／control Resetとは区別される。
- `develop.updateProcess`で明示的に最新processへ更新できる。

根拠：[crates/develop/src/settings.rs:11](/I:/code/lightcraft/crates/develop/src/settings.rs:11)、[settings.rs:78](/I:/code/lightcraft/crates/develop/src/settings.rs:78)、[settings.rs:103](/I:/code/lightcraft/crates/develop/src/settings.rs:103)、[crates/engine/src/cmd/query.rs:170](/I:/code/lightcraft/crates/engine/src/cmd/query.rs:170)、[crates/engine/src/cmd/develop.rs:285](/I:/code/lightcraft/crates/engine/src/cmd/develop.rs:285)。

**推奨：** GenzoRoomには`develop.get`で取得した設定全体、明示的な`process`、LightCraftのバージョン／commitを保存する。upstream更新時に既存写真のprocessを自動更新しない。未知JSONフィールドの完全な往復保持は、このserde構造だけでは保証されないため、将来版から旧版への設定の読込み・再保存にも注意が必要。

### 5.5 Previewと最終Exportで同じ設定を使う方法

PreviewもExportも、カタログ内の同じ写真の`DevelopSettings`からジョブを作成する。専用Adapterでも、設定をSessionへ適用した後、同じ写真IDからPreviewとExportを作れば設定を共有できる。

Exportには`export_photo()`、`prepare_batch()`、`prepare_export()`、`PreparedExport::run()`などがあり、準備済みExportの重い処理はSession外のワーカーで実行できる。

根拠：[crates/engine/src/media.rs:1218](/I:/code/lightcraft/crates/engine/src/media.rs:1218)、[media.rs:1590](/I:/code/lightcraft/crates/engine/src/media.rs:1590) `render_export()`、[media.rs:1607](/I:/code/lightcraft/crates/engine/src/media.rs:1607) `export_job()`周辺、[crates/engine/src/export.rs:1560](/I:/code/lightcraft/crates/engine/src/export.rs:1560)、[export.rs:1621](/I:/code/lightcraft/crates/engine/src/export.rs:1621)。

同一設定でもPreviewとExportの画素一致を意味しない。ソース解像度、Draft品質、出力色空間、HDR、出力シャープ処理などが影響する。比較する場合はSDR・sRGB・Full品質を揃える必要がある。pipelineは空間パラメータを画像長辺に対する相対値で扱う設計だが、今回Preview／Export間の見え方や数値的一致を実測したものではない。

## 元資料Aの補足（ソース調査）

### DNG寸法、previewOnly、出力寸法

- `crates/raw/src/dng.rs::decode`はTIFF/DNG raw IFDから幅・高さ等を読み、`ActiveArea`、`DefaultCropOrigin/Size`、`OpcodeList1/2/3`を解析する。数値cropは`crates/raw/src/lib.rs::normalized`と`develop_crop`、opcode処理は`crates/raw/src/opcodes.rs`にある。
- `crates/raw/src/lib.rs::develop`はRAW mosaicの正規化・demosaic・OpcodeList3・デフォルトcropを行う。`develop_binned`は低解像preview用途にも存在する。通常のCLI exportでどちらの入力寸法になるかは、ファイルimport/export経路と要求サイズに依存する。
- `apps/lightcraft-cli/src/main.rs::render`のhelpでは`--size`の既定値が「full size, cropped」。`--preview`はrenderの既定オプションではなく、別コマンドのpreview機能。`--size`を省略したv0.9.1 DNG現像ではPixel 4064×3056、Pentax 5472×3648が実測された。
- `crates/engine/src/files.rs::probe_bytes`はRAWを`probe_info`できない場合に埋め込みpreview寸法と`preview_only: Some(reason)`を記録する。RAW probe成功時はRAWのdeveloped寸法と`preview_only: None`を記録。`crates/engine/src/cmd/query.rs::photo_summary`は`p.preview_only`を`previewOnly`として返すため、JSONの`null`は「preview-only理由が記録されていない」ことを示す。それだけで実際の全解像度pixel decode/exportや埋め込みpreview不使用までは保証しない。
- 初期Pixel `sample.dng`の縮小原因は未確定。保存された`output\dng-rawinfo.log`はoffline時に`backtrace v0.3.76`を取得できず終了し、RAW IFD寸法、ActiveArea、DefaultCrop、OpcodeList、埋め込みpreview寸法を示すタグ出力がない。ソースにcrop・binning・preview fallback経路があることと、sample固有の原因確定は区別する。
- Pixel `sample2.dng`の実出力は4064×3056だが、保存された個別IFD/ActiveArea/DefaultCropタグの採取記録は確認できない。4080×3072は当初Pixel DNGについて会話で申告された寸法で、sample2に対する独立したタグ証跡とは区別する。

### CLI設定JSONとProcess Version

- `render`は`--set control=value`を複数受け付け、例は`--set light.exposure=1.0`。`--quality`は1〜100、既定92。`--size N`省略時はcrop後のfull size。
- `--settings`はJSON objectを`read_settings`で読み、`develop.merge`で部分設定をmergeする。preset/XMP preset入力も扱う。CLI render内のSessionは一時セッションで、`--settings`は指定ファイルを書き換えない。GenzoRoom固有JSONの保存/再読込round-tripは未実施。
- `DevelopSettings`は`crates/develop/src/settings.rs`でSerde serialize/deserializeされる。v0.9.1では`Process::LATEST = V2`。新規設定はlatest process、field欠落・不正値はlegacy V1として読む。保存済みsettingsは編集時の見た目を維持するためProcess Versionを持つ必要がある。
- CLI方式は実証済みでプロセス境界があり、GenzoRoom側のRust ABIやengine内部型への結合が少ない。Rust crate直接利用は`lightcraft_engine::export::export_photo`等に接続できるが、`Session`、catalog、media/export typesとfeature構成への結合が増える。統合自体は未実施。

## XMPサイドカー入出力の追加調査（2026-10-20）

### 確認方法と範囲

以下は基準commitのソース確認結果。XMP保存・読込の実行、元RAW/JPEG・既存XMPへの書込み、Immichとの往復検証はしていない。LightCraft内の既存回帰テストはコードを読んだだけで、今回は実行していない。

### LightCraft v0.9.1の確認済み仕様

| 項目 | ソース上の仕様 |
|---|---|
| namespace・payload | `lc`のURIは`http://ns.lightcraft.app/lc/1.0/`。`lc:settings`は完全な`DevelopSettings`をJSON文字列として格納する。GenzoRoom RecipeやUndo履歴の格納形式ではない |
| XML | `parse_xmp()`はnamespace URIでprefixを正規化し、属性形式・要素形式、配列・構造、XML entityを読む。`write_xmp()`／`write_xmp_lc()`がXML packetを生成する。JSONとXMLのescapeは別段階 |
| 保存 | `photo.saveMetadataToFile {ids?}`は元ファイルの隣にsidecarを生成。`written`、`merged`、`backups`、`failed`を返す。部分失敗を確認する必要がある |
| 保存条件 | 元ファイルが存在する絶対パスであることが必要。virtual copyは個別sidecarへ保存できず、設定はlibrary内にのみ保持 |
| 設定内容 | `sidecar_packet_with()`が写真の`develop`全体をSerdeでJSON化。schema versionと描画processは別。V1のprocess省略規則などは本書5.4を参照。エンジンcommitやGenzoRoom情報を自動付加する契約ではない |
| 併記される情報 | rating・label・title・caption・creator・copyright・keywords等の標準metadata、`lc:flag`・`lc:location`。設定だけを書き出すAPIとして無条件には扱えない |
| 再読込 | import時、および`photo.readMetadataFromFile {ids?}`で適用。後者はmetadataと設定をまとめたUndo編集となり、`read`・`failed`・必要時`warnings`を返す。auto-write有効時でもこの読込自体ではsidecarを書かない |
| 設定の優先順位 | 有効な`lc:settings`をJSON→`DevelopSettings`として読めれば全体設定を適用。それがない／読めない場合、対応する`crs:`調整があれば部分変換する。`lc:settings`が不正でも常にエラーとなるわけではない。`crs:`変換は他現像ソフトとの完全な描画互換を意味しない |
| metadataの優先順位 | sidecarのmetadataを適用するが、撮影日時は元画像の値が優先し、欠落時だけsidecarで補完する。設定バックアップの読込が他metadataにも影響する点に注意 |
| 命名 | 既定`stem`は`IMG_1.xmp`、`full`は`IMG_1.CR3.xmp`。候補探索は命名設定を優先し別形式・大文字拡張子も扱う。同stemのRAW/JPEGがカタログにある場合、RAW優先の所有者以外はfull命名へ分離する |
| 自動保存 | `library.xmpPreferences {autoWrite, naming}`で設定。既定auto-writeはfalse。保存失敗の待機・再試行APIもある。統合時に無意識に元画像隣へ保存しないよう、設定と実行コマンドの責任を決める必要がある |
| 既存XMP保護 | `OWNED`（`lc:*`を含む）と条件付き所有propertyをmergeし、その他のnamespaceや`crs:`・`xmpMM`を保持する実装。読めない非空packetはbackup後に置換し、読取I/O失敗は盲目的に上書きしない。空白だけのファイルは新packetになる。書込はtemp・sync・rename経路 |
| Original export | `format=original`は元画像バイト列のコピー＋設定sidecar。現像済みJPEGの生成とは異なる。GPS入りoriginalで位置情報除去が必要な条件は拒否される場合がある |

根拠（固定commitのローカル参照）：

- [meta XMP API・namespace](/I:/code/lightcraft/crates/meta/README.md)、[xmp.rs](/I:/code/lightcraft/crates/meta/src/xmp.rs)、[xmp_merge.rs](/I:/code/lightcraft/crates/meta/src/xmp_merge.rs)。
- [sidecar.rs:139 parse_sidecar](/I:/code/lightcraft/crates/engine/src/sidecar.rs:139)、[sidecar.rs:333 packet生成](/I:/code/lightcraft/crates/engine/src/sidecar.rs:333)、[sidecar.rs:504 read_packet](/I:/code/lightcraft/crates/engine/src/sidecar.rs:504)、[cmd/xmp.rs](/I:/code/lightcraft/crates/engine/src/cmd/xmp.rs)。
- [import.rs:1063 読込候補](/I:/code/lightcraft/crates/engine/src/import.rs:1063)、[export.rs:1746 Original export](/I:/code/lightcraft/crates/engine/src/export.rs:1746)。
- [tests_xmp.rs:save_delete_library_reimport_restores_edits](/I:/code/lightcraft/crates/engine/src/tests_xmp.rs:51)にはPNGを使った完全設定・mask・metadataの復元assertionがある。これは今回のRAW/JPEG実機round-trip成功の証拠ではない。

### RAWとJPEGの適用可能性（ソース上の範囲）

- RAW/DNG：外部sidecarの読込・書込があり、sidecarの読取候補が得られなければ元RAW内のembedded XMPを使う経路がある。DNG全般・全カメラでの復元成功や画素一致は未検証。
- JPEG：外部sidecarの設定を読む経路はRAW限定ではなく、保存も元ファイル条件を満たすJPEGを排除していない。既に現像されたJPEGに対する追加調整であり、RAW現像設定を同値で移して同じ見え方になるという意味ではない。
- `read_packet()`とimportの**develop設定復元**でembedded XMPをfallbackとして使うのはRawの場合。JPEGに埋め込まれた`lc:settings`だけでこの経路の復元が成立すると仮定しない。一般metadata抽出のJPEG embedded XMP対応とは別問題。
- RAW・JPEGが同stemでも別入力・別設定として識別する必要がある。外部画像の隣への保存と、独立したダウンロード用XMP生成を同じ操作として扱わない。

### GenzoRoomの現状との対応（ローカルソース確認）

| GenzoRoom | LightCraft／XMPとの関係 |
|---|---|
| Recipe v18 | `adjustments`にWB・露光・トーン・grading・色、section/rangeのenable、個別`adjustmentEnabled`を保持する独自構造。`DevelopSettings`と同じschemaではない |
| processing version | `jpeg-preview-srgb8-v1`。LightCraftの`process` V1/V2とは別の描画契約。名前の似たcontrolも数値・単位・アルゴリズムの一致は確認していない |
| 編集状態 | `stateFormatVersion=2`、`recipeVersion`、`processingVersion`、`currentRecipe`、`history`、`historyCursor`、`sourceIdentity`を保持。`lc:settings`だけではこの状態を復元できない |
| 入力識別 | 現行`sourceIdentity`は`provider: immich`、`assetId`、`inputKind: immich-preview`、任意checksum等。RAW originalの識別契約として流用できると確定していない |
| JPEG export | `jpeg_metadata.py::_preserve_xmp()`は許可されたDC項目とRating/Label等を抽出してpacketを再構築する。任意の独自namespaceや`lc:settings`を無損失で運ぶ経路ではない |
| Immich upload | `immich_export.py`の`POST /assets`は生成JPEGを`assetData`として送る。この経路にXMP sidecar送信は確認できない |

根拠：[editing.ts](../../../frontend/src/editing.ts)、[editState.ts](../../../frontend/src/editState.ts)、[edit_state.py](../../../backend/edit_state.py)、[jpeg_metadata.py](../../../backend/jpeg_metadata.py)、[immich_export.py](../../../backend/immich_export.py)。リンクはこの文書からのリポジトリ相対パス。

Recipeの値を`lc:settings`へそのまま入れることは既存形式の互換利用ではない。変換器がないため、現段階での両者の対応は「異なる描画系の設定」という関係に留まる。

### Immichとの関係（公式文書確認・実機未検証）

2026-10-20に[Immich公式XMP Sidecars](https://docs.immich.app/features/xmp-sidecars/)を確認した。公式説明では標準metadataの抽出・書戻し、既存項目とのmerge、full名優先・stem名fallback、CLI upload時の検出・コピー、外部libraryのDISCOVER/SYNCを扱う。mount権限による制限もある。

これはGenzoRoomの既存upload処理がsidecarを送れることや、利用中のImmichで独自namespaceが無損失往復することを確認した結果ではない。公式の対応フィールド一覧は`lc:settings`やGenzoRoom Recipeの解釈・描画を約束していない。ImmichをRecipe保管・変換エンジンとして扱う根拠はない。適用先のImmichバージョン、API、権限、sidecarダウンロード・更新・競合時の挙動は未調査／未検証。
