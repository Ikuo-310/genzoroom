# LightCraft v0.10.0 RAW描画解像度制御調査

調査日：2026-10-23（Asia/Tokyo）。静的ソース調査と資料収録のみ。以下の推奨は実装方式を選ぶための判断材料であり、新工程の開始・仕様確定・実装完了を意味しない。

## 1. 対象・証拠・結論

- LightCraft本家：v0.10.0、commit `a2a41383c4fd62fa85a46ccd00998639221f2d3c`（[固定ソース](https://github.com/storytold/lightcraft/tree/a2a41383c4fd62fa85a46ccd00998639221f2d3c)、以降LC）。ソース参照はこのcommitのファイル／1始まりの行番号。Web版からの推測ではなく、native eguiのEdit → detail Viewer → Renderer → JobPool → Engine／GPU／CPUを追跡した。
- 読取checkout：`I:\code\raw-test\lightcraft-v0.10.0-gpu-poc`。HEADは固定commit。既存の変更はMCPの`headless.rs`、`tools.rs`、`tests/e2e.rs`にあるため保持し、本家のMCPは`git show a2a41383:<path>`、拡張はGenzoRoom管理patch本文を別々に確認した。`I:\code\lightcraft`のHEADは`4f0b110bcbd2e350c6d97b47f1d824c2222295c4`であり、今回の固定ソースには採用していない。gitignoredの`plan/STATUS.md`等は本作業環境に存在せず、ソースと公開docsを根拠とした。
- GenzoRoom：`I:\code\genzoroom`、`feature/lightcraft-integration`、調査開始HEAD `4edf3e8dfd6441f48115151c4acda8e085898ec6`（C4-F完了）。作業ツリーcleanを確認。以下のGenzoRoom行番号はこのHEADに対する参照。
- 管理patch：[`0001-native-before.patch`](../../../native/lightcraft/patches/0001-native-before.patch)。[`manifest.json`](../../../native/lightcraft/manifest.json)の本家commit／versionと一致。patchファイルSHA-256は`7536727b570ac9cb47c9f2e0ad5c3f25f94b9082cf63408f9dcea59daa5425a3`でmanifestと一致。今回、再適用・ビルド・実binaryのreceipt再検証は行っていない。

**結論（ソース上の事実）：** デスクトップは固定1280pxの二段階ではない。操作中はDraft、確定後はFullという2品質だが、解像度は表示面積・ズーム・設定・GPU可否・時間から選ぶ。拡大時には全体画像と表示領域のwindow renderを併用する。Full品質とRAW原寸は別概念である。MCP headlessは同じEngine現像処理に到達する一方、このViewer制御を通らず、指定サイズで同期Full描画する。

**推奨（実装案）：** B（GenzoRoom側の二段階要求制御）を第一候補とする。既存MCPは1280pxと長辺4096px以下の高解像度を指定できる。現行C4は1024pxとPNG容量・同寸法比較の契約を持つため、定数1個の変更では成立しない。1280pxは性能評価前の候補値であり、採用確定値ではない。三段階品質、RAW用Preview／Originalボタン、History／Undo／Redo／保存仕様の変更は提案しない。

本書の「事実」はコード上の到達可能性を示す。「提案」は未実装、「未検証」は今回実行していない事項である。既存C4-Fの完了記録・ユーザー実機確認済み範囲を変更しない。

## 2. デスクトップの実際の描画シーケンス（事実）

| 段階 | 実処理・ソース |
|---|---|
| 開始・更新・終了の検出 | `crates/ui-egui/src/widgets.rs::slider`、`SliderOut` (197-202)。trackの`resp.drag_started()` (398-399)、drag中の値更新 (401-425)、`resp.drag_stopped()` (436-437)。数値scrub (290-350)、数値確定／クリック／キー等にも開始・終了通知がある。pointer releaseだけが境界ではない |
| Engineへ反映 | `panels/edit.rs::apply_slider_out` (19-37) が開始時`develop.beginInteraction`、値に`develop.set`、終了／reset時`develop.endInteraction`を実行。`control` (40-45) が通常のcontrolと接続 |
| interactionの意味 | `crates/engine/src/cmd/develop.rs` (1135-1147)、`crates/engine/src/lib.rs::begin_interaction/end_interaction` (941-964)。開始前設定を保持し、終了時に`interaction.take()`、変更があれば最終値を1 undo stepとしてcommit。これは履歴集約の境界でもある |
| Viewerが品質と寸法を計画 | `panels/detail.rs` (523-570)：`session.interaction.is_some()`、GPU可否、`DragScale`、物理表示寸法から`region::plan`を呼ぶ |
| Afterの要求 | `detail.rs` (571-584)：`Session::loupe_job` → 操作中のみ`.draft()` → overlay／proof等 → `Renderer::request(Slot::Main, ..., 100)`。速いnative draftは予測frame時間の40%だけ同frame内で待つ（予測時間を1/240〜1/30秒に制限） |
| 実行 | `crates/ui-egui/src/render.rs::request` (452-483) がdisplay profile、request ID、slot別StageCacheを付与し、native JobPoolへ投入。`crates/engine/src/media.rs::RenderJob::run/run_photo` (872-1011) がsourceをロードして現像 |
| 結果表示 | `render.rs` (775-879) が完了結果の世代・request ID等を判定し、Sessionにsourceを受け入れ、表示textureへ変換。次のframeのViewerがtextureを描く |
| 操作確定後 | `interaction`が無くなるため、次のViewer frameでdraft scale解除、再計画、`.draft()`なしのFull job。サイズが同じでもqualityのkeyが異なるのでFull要求になる。固定の「確定後○ms待つ」timerが切替の根拠ではない |

`media.rs::RenderJob::draft` (785-792) は`request.quality = Draft`とkey変更を行う。画像寸法を縮める処理ではない。`crates/pipeline/src/lib.rs::RenderRequest::fit` (175-187) は既定Full／sRGB／U8／windowなし。`Quality` (120-125) はDraftとFullのみ。Draftは高コスト処理の近似にも影響し、例として`pipeline/src/local.rs::plane_sigmas` (490-502) はtone用sigmaを24で打ち切り、`pipeline/src/lib.rs` (582-591) はNR変更時に以前の広域planeを再利用できる。低解像度Fullを要求するB案は、desktop Draftの完全再現ではない。

写真初回表示にはcached／embedded／thumbnailのstand-in (`detail.rs:618-623`) や隣接写真のprefetch (598-615) もある。これは操作品質の三段階制御を意味せず、今回GenzoRoomに新設する案でもない。

## 3. 解像度の選択とViewer／ズーム（事実）

### 3.1 表示寸法

`detail.rs::fit_rect` (99-135) はFitならpane内に収め、Fillならpaneを埋め、Percentならcrop／orientation後のnative画素数×倍率÷pixels-per-point (`ppp`) で表示rectを作る。100%を超える表示も可能だが、region側の現像はnative画素数までで、その先はtextureを拡大する。

`detail.rs:535-570`では、アニメーション途中ではなく最終target rectの長辺×`ppp`を`drawn_long`、canvas長辺×`ppp`を`canvas_long`とする。Afterの出力はaspectに合わせた`rw,rh`（各8以上）。side-by-side／stacked比較はpaneを分けるため、単一画像表示とは表示面積が変わる (`detail.rs:469-492`)。

### 3.2 制約値と式

| 項目 | 値・条件・根拠 |
|---|---|
| 設定 | `state.rs:354,405,486`：`preview_limit`既定0（Automatic）。選択肢`[0,1600,2560,3840,5120]` |
| 全体画像の基本上限 | `AppSettings::loupe_edge` (`state.rs:528-539`)：設定0なら8192、指定ありなら512〜8192にclamp。texture side（最低512として扱う）でも制限。要求を8以上にし整数化後64px単位で切上げ、native長辺と上限で切る |
| 通常の全体描画 | `region.rs::plan` (227-260)：window利用可能なら基本要求は`min(drawn_long, canvas_long) × draft_scale`。Automatic時はさらにSourceLevel::Preview=2560で上限。明示設定時はそのpreview_limitをsource capとする |
| 操作中のscale | `region.rs::DragScale` (109-218)：GPU対象で過去に遅かった(photo,control)でなければ1.0、それ以外0.6。CPUの操作中は固定1280ではなく通常サイズの60% |
| 時間適応 | render時間＋uploadを含む表示frame時間を観測。最初のsampleを除いた中央値が16ms超のdragは次回0.6。drag中でもsample数が3超、中央値が32ms超なら0.6へ変更。遅いpairの記憶は256組まで。1操作内のサイズが絶対不変というわけではない |
| windowへ切替 | `region.rs:64-65,227-260`：`frame_edge > undrafted_main_edge × 1.25`が基本条件。Fit相当（drawn≤canvas×1.05）で明示preview_limitありならwindowを出さない。window中の操作では全体画像scaleを最大0.6にする |
| windowの仮想frame | `state.rs::window_frame_edge` (554-560)：表示長辺を8〜65536に制限しnative長辺でも切る。preview_limitを直接適用しない |
| windowの実領域 | `region.rs:11-19,46-61`：256px grid、context marginは長辺の4.5%を基に切上げ（基準cap 3072）、native最大span 6144かtexture limit（`region.rs::window_for:336以降`で実領域を算出）。`detail.rs::request_window` (356-415) がvisible範囲をframe座標へ変換して要求 |
| zoom／pan gesture | `region.rs::SizeHold` (263-300) と`detail.rs:560-565`：gesture中と静止後0.25秒は従来のrender sizeを保持。スライダー確定の待機時間とは別 |
| whole-frameが必要な場合 | 全体contextが必要なdiagnostic overlay、spots／Auto Mask等の遠距離readでwindowが拒否された場合は全体描画へ戻る (`detail.rs:540-554,391-400`)。window不可なら静止時はdrawnサイズ、drag時はcanvasまでに抑える (`region.rs:232-240`) |

したがって「1280→4080」という2値をdesktopの設定変更だけで直接指定するAPIではない。GPU操作中は静止時と同じ寸法のDraftになることもあるし、確定後も全体画像は2560以下で、拡大部分だけ鮮明になることもある。

## 4. GPU／CPU、source、領域描画（事実）

### 4.1 共通現像経路

`media.rs::build_job` (1207-1269) は写真・設定・出力寸法・crop・SourceLevel・content等からjob/keyを作る。`loupe_job` (1409-1413) はview preview cacheを付ける。`RenderJob::run_photo` (955-1005) はsourceをロードし、thumbnail cache job以外でGPU利用を許可して`develop_reporting` (1025-1069) へ渡す。

`develop_image` (1041-1069) はLUT profile、visibleかつrefine>0のmask、proofありをCPUへ回し、それ以外は`lightcraft_gpu::try_render`を試す。GPU無効／利用不可／非対応／失敗時はCPUの`pipeline::render_cached`（StageCacheあり）または`render`へ進む。desktopの`gpu::handles`判定だけで毎jobのGPU成功は保証されないため、DragScaleは実測時間も使う。

`crates/gpu/src/lib.rs::handles/try_render` (446-530) はnative U8・非proof・非HDR-range overlayを対象とし、adapter／buffer／readback／OOM等の失敗でCPU fallbackする。buffer上限は`crates/gpu/src/ctx.rs` (303-315,369-380,489-497) のdevice `min(max_storage_buffer_binding_size,max_buffer_size)`。desktopのegui texture side制約と、compute buffer制約は別である。GPU使用可というだけで4080pxの処理速度・VRAM充足を保証できない。

RAWファイル読込／decode／binning／demosaic／camera colourは`crates/engine/src/files.rs` (355-360,368-485,1062-1075,1096-1101) の共有filesystem loaderを通る。GPU現像でもこのsource準備全体がGPU化される意味ではない。

### 4.2 sourceの解像度と実際の現像領域

- `media.rs::SourceLevel` (93-114)：Thumb最大512（for_sizeでは520まで）、Preview最大2560、Fullは原寸source。これらはデコードsourceの段階であり、ユーザーへ提示する3段階品質ではない。
- `source_edge_needed` (118-129) はcropが狭いほど出力に必要なsource長辺を増やす。通常1280出力はPreview sourceだが、tight cropではFull sourceになり得る。長辺2560超の要求はFull sourceを選ぶ。
- `files.rs::load_bytes_now` (407-485) はまずRAWをdecodeし、Previewでは可能ならmosaicをbinningして現像、Fullでは原寸demosaicする。RAWセンサー配列全体のdecodeと最終出力全域の原寸現像は区別する。
- desktopのMainは全体フレームを表示サイズ程度で現像する。拡大時は`Session::region_job/region_job_before/region_job_of` (`media.rs:1416-1499`) が仮想full frame内のwindowを`RenderRequest.window`へ設定する。context付き領域を現像してtextureを重ねる方式であり、常時RAW全域を原寸出力する方式ではない。ただしwindowでもFull sourceの全体decodeを要し得るため、完全なRAW ROI decoderとはいえない。
- MCP `render_preview`はregion jobを呼ばず、`render_job`のwindowなしで写真全体（crop適用後）を指定boxに現像する。高解像度化すればその出力全体にコストが掛かる。

## 5. RenderJobの生成・集約・キャンセル・古い結果（事実）

desktop `Renderer::request_needed/request` (`render.rs:416-483`) は同keyのtexture／pending等を再要求せず、slotごとの最新request IDを記録しStageCacheを渡す。native `crates/preview/src/pool.rs::JobPool::submit` (181-193) は同slotの未開始jobを置換し、実行中は同slotの次jobが待つ (`pool.rs:33-36,258以降`)。

**実行中jobの強制中断ではない。** 通常のdrag更新では未実行要求を集約し、完了時に結果の採否を決める。`render.rs:780-817`はdisplay profile違いを捨て、request ID違いでもview slot・現epoch以降・表示済みより新しい・成功結果なら中間結果を受け入れる（コード上の`newer_draft`条件はquality自体を比較していない）。これで連続drag中に全結果が古くなって表示が止まるのを避ける。その他の古い失敗／source／pixelは捨てる。最新keyの結果だけpendingを消す。

`forget_all` (`render.rs:556-570`) はepochを進め、request ID／textures／stages／queued job等を無効化する。Engine `Session::accept` (`media.rs:1550-1577`) とsource key検査もsourceの受入境界。`RenderJob.request_id`はfrontend用で、settings／size等のrender keyとは別 (`media.rs:733-749`)。

GenzoRoomはこのRendererを利用していない。既存adapterのAfter latest-wins、Before別slot／cache、epoch／sequence／revision判定 (`backend/lightcraft_raw.py:917-1055`) とFrontendのserial・owner判定を使う。desktopの「supersededでも表示済みより新しければ採用」をそのままC4へ移す根拠はない。

## 6. Before/Afterの実経路（事実）

desktop Beforeは同じRAWを`Session::before_settings` (`engine/src/cmd/before.rs:17-20`) で再現像する。既定は`Photo::import_defaults()`、custom Beforeがあればその基準を使い、crop／orientationだけ現在値へ揃える。Afterのoptics等を全て転写する仕様ではない。

`detail.rs:568-570,624-628`はBefore全体を`render_job(..., before=true, apply_crop)`で作り`Slot::Before`へ要求する。全体Beforeは`stand_in_edge`で最大2560、通常Afterのwant以下。全体Beforeはdrag中もここで`.draft()`を付けない。拡大比較では各表示sideに`region_job_before/region_job`を作り、windowは両側とも操作中Draft (`detail.rs:356-415,630-680`)。配置・wipe・clipはUI側 (`detail.rs:705-780`)。BeforeはproofやAfter overlay等の適用もAfterと異なる。

GenzoRoomのpatchはBeforeをheadlessに追加し、`render_job(id,size,size,true,true)` → `run` → `Session::accept`を使う。Afterは既存`render_now`のまま。schemaのboolean `before`、応答`kind`、import／effective Before fingerprint、crop／orientation metadataを追加するが、解像度clamp・Draft・region・StageCache継続利用は追加しない（patch hunkの本家位置：`headless.rs:53,130,140`、`tools.rs:118,514,618`）。runtimeはschemaとmetadataを検査し、import基準は既存C4のまま維持する。

## 7. MCPから再利用できること・不足すること

### 7.1 現行headless MCP経路（事実）

```text
GenzoRoom rawPreview → RawPreviewApi._preview
  → LightCraftRawSession.request_preview / _previews
  → LightCraftManager._raw_preview
  → MCP render_preview(max_side, format=png, before?)
  → tools.rs::render_photo → Backend.call("ui.render", size, temp path, before?)
  → Headless::render → Session::render_now（After）
                      または render_job(before=true).run（管理patch）
  → build_job / source load / develop_reporting → GPU または CPU
  → temp PNG → image_result → Base64 image＋metadata JSON
  → PythonでPNG検証 → loopback HTTP image/png → decodeFrame → Viewer
```

根拠：GenzoRoom `backend/lightcraft_runtime.py:334-341,556-573`、`lightcraft_raw.py:979-1030`、`windows_raw_api.py:258-300`、`frontend/src/rawApi.ts:249-276`、`useRawDocument.ts:77-99`。runtimeは`mcp --headless --compact`で常駐する。

本家MCP `crates/mcp/src/tools.rs`：schema (116-126)、`render_preview` (620-625) が`max_side`→`size`に変換し、`render_photo` (502-524) が既定1024、16〜4096へclamp。本家`Headless::render` (`headless.rs:52-57`) は16〜16384へ再clampするが、この4096上限を広げるものではない。`render_now` (`media.rs:1581-1585`) は常に通常Full jobで、`session.interaction`を見てDraftへ変える処理はない。

MCP `command_run`で`develop.beginInteraction/endInteraction`を呼べても、headlessの描画解像度／品質は自動切替されない。`mcp --connect`でdesktopへ接続しても`ui.render`は`ui-egui/src/control.rs:440-459`の同期`render_now`を呼び、Viewerの`region::plan`／Rendererは迂回する。さらに現在のBefore patchはheadless向けで、desktop `ui.render`はBeforeを実装しておらずpatchのkind検査で拒否される。desktop起動へ接続し直すだけではA案は成立しない。

### 7.2 サイズ別の可否（コード上の到達可能性）

| 要求 | LC／MCP | 現行GenzoRoom |
|---|---|---|
| 長辺1280 | `max_side:1280`は有効。aspect維持、Full品質。GPU／CPUの共通経路 | 1024契約で拒否。HTTPもサイズ指定を受けない |
| 4080×3072 | 長辺4080は4096以下なので要求可。ただしAPIは`max_side:4080`であり、縦横の完全指定ではない。実際のcrop／orientation／レンズ込みaspectが対応する場合にこの寸法になる | 長辺／pixel／byte上限、比較寸法等への対応が必要 |
| 長辺4096超・全RAW原寸 | `render_preview`は4096へclampするので原寸保証不可。Full sourceを読むことと原寸出力は別 | 現行経路では不可。将来MCP拡張、または別のファイル経路の評価が必要 |

`pipeline/src/geometry.rs::Frame::fit` (184-195) はbox内でaspectを維持する。4080×3072のセンサー公称寸法が、そのまま現像後寸法になるとは限らない。Previewにはdesktopのnative上限選択そのものは無いため、小画像で過大要求しないサイズ契約も必要。

### 7.3 画像取得の代替経路（事実と評価）

- MCP `render_preview`はPNG／JPEG対応だが、GenzoRoomはPNG専用。JPEG指定は`tools.rs::image_result` (449-494) で一旦PNGを読み、decode／sRGB8化してquality 88で再encodeする。転送削減候補ではあるが、余分な処理と非可逆圧縮があり、現行PNG検証を流用できるわけではない。
- legacy `render_photo`は`path`保存を受けるが、`image_result`は保存してもBase64 imageを応答する。`render_preview`の引数転送には`path`が無く、画像なし応答への切替にはならない (`tools.rs:502-524,620-625`)。
- `command_run`経由のheadless `app.export`はJPEG／PNG等をファイルへ出しmetadataを返せる。`longEdge:0`の原寸出力も既存機能 (`headless.rs:60-96,134,152`およびexport parameter定義)。ただしExport専用設定・path管理・上書き保護を持ち、Beforeのread-only preview契約を提供しない。ローカル一時ファイル＋HTTP配信候補にはなり得るが、C4から直ちに使える同等Preview APIではない。
- control channelの`ui.render {path}`はファイル＋metadata経路だがMCP toolの公開Preview経路とは別。現在のGenzoRoom runtime／画像validatorはこの経路を公開していない。MCP resource (`server.rs:34-41,196-229`) はJSON状態／設定等で、画像用shared memory／binary stream／ROI resourceは今回追跡した公開経路にない。

1280／長辺4096以下のFull画像を返すだけなら、現行Before patch込みMCPに新機能は不要。Draft指定、slot別StageCache、window／tile、Viewer計画、画像を返さない一時ファイル参照、renderの協調キャンセル、4096超Preview等は既存`render_preview`に無く、選択時にはMCP側の拡張が要る。

## 8. 1024px・容量・時間の制約を層別に確認（事実）

| 層 | 制約・根拠 |
|---|---|
| LightCraft Engine | 1024固定なし。SourceLevel Preview=2560、要求が大きければFull source。desktopは別の表示依存上限 |
| MCP helper | 1024は既定値。実上限4096。管理patchはこのclampを変更しない |
| GenzoRoom adapter | `lightcraft_raw.py:27-44,219-286,917-920`：`MAX_PREVIEW_SIDE=1024`、要求16〜1024、pixel数≤1024²。PNG≤5MiB、Base64≤4×ceil(5MiB/3)、metadata≤16KiB。CRC／PNG終端／headerと実寸／Pillow verify/loadまで検証 |
| Windows HTTP | `windows_raw_api.py:80-83,258-300`：capabilitiesに1024／5MiBを広告。bodyはworkspace／generation／token／revision／serial／kind以外を拒否し、`maxSide`を指定できない。adapterの既定サイズを要求する。After待機中はHTTP admission lockを保持 |
| Python MCP transport | `lightcraft_mcp.py:7-8,183-208,269-272`：通常JSON line≤1MiB、`render_preview`応答≤8MiB。subprocess StreamReaderも8MiB (`runtime.py:334-341`)。5MiB PNGのBase64約6.67MiB＋JSONはこの枠内に収まる想定 |
| Frontend API | `rawApi.ts:7,46,249-276`：長辺1024、pixel数≤1024²、画像≤5MiB、image/png、所有権・serial・revision・kind等を検証。HTTPはbinary PNGだがMCP区間はBase64 |
| 時間 | `RawTimeouts` (`lightcraft_raw.py:37-44`)：admission 5秒、Preview 60秒、画像validation 10秒。Frontend Preview 90秒 (`rawApi.ts:252`)、decodeFrameは別に10秒のdecode期限処理 (`useRawDocument.ts:23-40`)。タイムアウトを単に延長すれば対話性が得られるわけではない |
| memory／GPU | adapter初期化は`app.memoryBudget {mb:1024}`を設定 (`lightcraft_raw.py:517-519`)。cache／work gateの予算で、複数process全体やPNG／Python／WebViewのhard RSS上限ではない。GPUはdevice buffer制限も持つ |

4080×3072＝12,533,760 pixels。**概算**としてRGBA8一枚47.81MiB、RGB32f一枚143.44MiB（各4／12 bytes/pixel、MiB=2²⁰）。さらに原寸source、CPU中間plane、GPU buffer、readback、PNG、Base64、JSON、Pillow、HTTP／Blob、表示texture、Before／旧Afterが同時に存在し得る。これはpeak実測値ではない。PNGは内容依存で5MiBを超え得るため、寸法だけ通しても表示保証できない。8MiB lineが許せるbinaryはJSON overheadを除いても概ね6MiB未満であり、5MiBだけ広げてもtransportで止まる。

1280も縦横比により1024比のpixel数が約1.5625倍、高解像度はさらに大きい。Preview sourceが同じでも出力処理・PNG・転送・decode負担は増える。`GPU_POC_V0.10.0.md`の既存1024px実測は今回再測定しておらず、1280／4080へ比例外挿して性能保証しない。

MCPは同期Previewの途中停止を提供しない。`server.rs:158`の一般cancel通知と`progress.rs:145-190`のbatch export写真境界cancelは、単一Previewの計算中断ではない。GenzoRoomのtimeout／cancelは送信後にtransport abort／session喪失となり得る (`lightcraft_mcp.py:183-208`、`lightcraft_raw.py:1031-1051`)。高解像度実行中の新dragを毎回process killする方式は既存の復旧・再生成・保存境界と衝突する。

## 9. 現行C4への接続上の問題（事実と提案）

### 9.1 操作確定境界と保存

**事実：** `RawAdjustmentControls.tsx:49-57` → `beginControls/changeControls/flushControls` (`useRawDocument.ts:381-385`) → `RawRecipeSave.begin/change/end` (`rawRecipeSave.ts:134-155`) がC4のgesture境界。共通`AdjustmentSlider.tsx:73-154`は数値Enter／Escape、pointer終了、keyboard／wheel静止等を扱う。category操作、Reset、Undo／Redo、History jump、再入場／再生成はdrag releaseだけでは扱えない。

`RawControls.change/flush` (`rawControls.ts:3,24-80`) は150ms debounce、latest unsent patch、native ACK後のreadbackを保持。pending patchが無い時にPreviewし、その完了を同じowner queueでawaitする。`RawRecipeSave.save/sendHistory` (`rawRecipeSave.ts:166-257`) はflush後に同queueへ保存barrierを置く。`end()`でgestureが直ちに消えるわけではなく、History ACK後に消す。従って`gesturing`だけをそのまま品質判定にすると、pointer確定後のfinal Previewも低解像度扱いになる可能性がある。

**提案：** 解像度phaseは表示要求の状態とし、永続Recipe／Historyやnative settings fingerprintへ混ぜない。既存gesture終了の意思とnative最終revision確定を区別する。同revisionで「低→高」だけを要求する場合も必要で、値が同じ／pending空でも操作確定後の高解像度要求を省略しない。新drag／History移動／owner変更／generation変更後の古い高解像度結果が表示を巻き戻さないrequest identityが必要。

高解像度待機を既存owner queueへ無条件に追加すると、次の編集、保存・Undo／Redo・離脱が描画時間だけ待たされる。逆にnative workの所有権を失う切離しも不可。どこで表示待ちを分離し、送信済みnative処理を既存barrierへどう合流するかは将来の検討事項であり、本調査ではqueue／保存仕様を変更しない。

### 9.2 Beforeと異なる解像度

**事実：** `LightCraftRawSession.before_key` (`lightcraft_raw.py:905-915`) はsource identity／engine／import基準／process／geometryに加えて`maxSide`を含む。Beforeには独立pending／sequenceとcacheがありAfter優先 (`917-1030`)。しかしHTTP応答のkey確認 (`windows_raw_api.py:280-289`) は既定maxSideの`before_key(handle)`、documentのbeforeKeyも同じ既定値である。サイズを増やすだけでは任意サイズBeforeの契約が通らない。

Frontend `useRawDocument.ts:284-327,369-371`はowner/keyに加えBefore／Afterのwidth・height完全一致を要求し、不一致をerrorとしてBefore URLを出さない。例えばBefore1024／After4080では現行比較が使えない。Before取得effectもサイズを依存keyにしていない。これは単なる表示拡大で解決できないAPI／cache整合性の問題。

**提案：** 二段階の各表示サイズと整合するBeforeを既存native Before基準で取得し、resolutionも要求／cache identityへ伝える案が最小の候補。別案の異解像度比較には共通の論理frame、aspect／crop／orientationと寸法丸めの扱いを定義し、既存完全一致guardを置き換える根拠が必要。どちらも未実装。Before取得はAfterをsupersedeしない優先順位、失敗時もAfter編集を継続する保証を維持する。

### 9.3 Viewerの表示尺度

**事実：** `ImageViewer.tsx:128-166`はdocument identityが同じならzoom/panを保持し、Fitでは新しいimageSizeから再fit、非Fitでは新寸法に対してpanをclampする。表示widthは`imageSize.x × scale` (`327-336`)。従って同じscaleのまま1280→4080に交換すると非Fitの見かけ倍率／表示範囲が変わり得る。現在のRAW等倍はPreview pixel基準である。

**提案：** 画質交換とcrop／orientation変更を区別する共通の論理表示寸法を検討する。高解像度画像の到着を新documentと扱ってzoomをresetする案も、現行操作感を損なう。desktopのzoom／ROIが既存MCPから自動的に提供されるわけではない。

## 10. A／B比較と推奨（未実装の評価）

| 観点 | A：desktop既存描画制御をMCPから利用 | B：GenzoRoomで二段階の要求を制御 |
|---|---|---|
| 再利用するコード | `DragScale`、`region::plan`、`AppSettings::loupe_edge`、Renderer／JobPool、StageCache、region job、Engine pipeline | C4のgesture／ACK／owner／revision／latest-wins、MCP `render_preview(max_side,before)`、Engine GPU／CPUとsource cache |
| 現APIで可能か | 不可。headless／--connectの`ui.render`ともViewer制御を迂回。Engine interactionコマンドだけでは不足 | native側は1280／長辺4096以下のFull画像を既存APIで取得可。GenzoRoomのHTTP／validation／scheduler／Viewerの接続変更は必要 |
| 必要なMCP拡張 | viewport／DPR／zoom／pan／native寸法／phase／render identity、状態を保持するplanner、非同期結果採否、必要ならregion返却。GUIにある計画をheadless用に切出すかdesktop依存を導入する必要 | 基本案なら追加patch不要。任意Draft指定・継続StageCache・ファイル転送・ROI・協調cancel・4096超が必要と分かった時だけ拡張候補 |
| 1280候補との整合 | desktopは固定1280を選ばない。固定長辺を強制すれば既存適応制御への追加policyになる | 操作中1280候補／確定後高解像度の2状態を直接表現できる。どちらもFull品質でもよく、三段階は不要 |
| 保守 | egui側の状態・表示時刻・GPU観測をheadlessへ対応し、上流のViewer変更にも追随。GenzoRoomとのstate二重管理が増える | 現行C4所有者を維持できるが、render phase／resolution identity／比較cache／表示尺度の整合と容量契約の保守が必要 |
| C4への影響 | native interaction／History集約とC4 History境界の混在、tile合成／比較／取消／保存barrierの調整が広範囲 | 保存データ形式を変えず表示層の要求policyを追加できる見込み。ただし高解像度awaitが保存queueを塞ぐ現状への配慮は必須 |

**推奨理由：** 今回の目的は固定候補1280と確定後の高解像度という二段階であり、desktopの表示領域別適応制御の完全複製ではない。Bは既存MCP／native Before／GPU・CPU現像を再利用し、C4の確定境界を主担当のまま保持できる。まず「高解像度＝長辺4096以下の全体画像」なのか「全RAW原寸／zoom時の画面pixel密度」なのかを将来の方式選択時に明確にする必要がある。後者は既存Preview APIだけでは満たせず、4096超やROIを含む拡張の評価が必要になる。

Bで性能が不足した場合に、StageCache継続利用や大画像の一時ファイル参照等の必要部分を狭くMCPへ追加する候補を残す。現行headless `render_now`のjobは`stages:None` (`media.rs:1264,1581-1585`) で、Session decoded-source cacheの再利用はあるがdesktop slot別StageCacheを自動利用しない。この差は1280の採用前評価で確認すべきである。

## 11. 未検証事項と本作業の終了範囲

以下は将来評価が必要な事項であり、今回試験を開始していない。

- 1280候補／4080〜4096の初回・warm・slider更新・確定後時間。native描画だけでなく、PNG／Base64／Python検証／HTTP／WebView decode／texture表示までの遅延。
- CPU fallback、GPU buffer／OOM、RAW機種・crop・回転・NR・mask等による所要時間と画質、Preview sourceとFull source／binningの差。12.5MP出力のpeak CPU RAM／commit／VRAM、Before同時保持、大PNGの容量分布。
- 操作確定と新dragの交差、同revisionの低→高、History移動・カテゴリ操作・再生成・離脱・保存Retry中の古い結果排除。高解像度job実行中の次操作と保存barrierの待ち時間。
- Beforeのサイズ別key／cacheとAfter優先、失敗回復、異サイズや丸めの整合、zoom／pan／Fitと高DPIでの表示尺度。
- ファイル返却／JPEG転送／ROI／Draft／StageCacheが必要かの判断と、必要なら既存patch管理・schema・receipt契約への影響。

今回実施した検証は固定commit／ブランチ／作業ツリー／patch digestの確認、関連コードと文書の静的追跡、追加Markdownの読直し、`git diff --check`のみ。ビルド・ベンチマーク・自動テスト・MCP実接続・ブラウザ／アプリ実動作・画像生成・SQLite変更は行わない。LCソース、GenzoRoom製品コード、MCP patch、既存C4設計／完了記録、README／CHANGELOGは変更しない。本書だけをCommit／Pushして停止し、実装へ進まない。
