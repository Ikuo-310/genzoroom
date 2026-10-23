# LightCraft v0.10.0 RAW描画解像度制御調査

調査日：2026-10-23（Asia/Tokyo）。静的ソース調査と資料収録のみ。以下の推奨は実装方式を選ぶための判断材料であり、新工程の開始・仕様確定・実装完了を意味しない。

> **追加調査の読み方：** §1〜11は前回調査commit `f32db26468f8c6f0265dc9d777bd5586247221cf`の記録を保持する。今回の要件（明示Draft／Full、表示依存解像度、4096px超の等倍）に対する再評価は§12以降。前回B案の「低解像度Full＋高解像度Full／追加patch不要」は今回のDraft要件を満たさない。1280pxは固定値ではなく、4096pxは現行MCP helperの制限にすぎない。

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

## 12. 追加調査：対象と推奨の再評価（2026-10-23）

追加調査開始時のGenzoRoomは`feature/lightcraft-integration`、HEAD `f32db26468f8c6f0265dc9d777bd5586247221cf`、作業ツリーclean。LCは前回と同じ固定commit `a2a41383c4fd62fa85a46ccd00998639221f2d3c`、既存MCP変更3ファイルを保持。§2〜8の既知の処理経路・定数を再調査するのではなく、qualityを受け渡す境界、quality依存処理、windowのgeometry、C4の描画／保存待機境界を追加で追跡した。以下のLC行番号は固定commit、GenzoRoom行番号は追加調査開始HEAD（製品コードはC4-Fのまま）。既存patchの位置は本家位置とpatch hunkで区別する。

**再評価した推奨（案）：GenzoRoomは操作境界と表示要求を所有し、LightCraftはDraft／Full現像・source／stage cache・geometry・必要時のregion描画を担当する。** まずRenderJobの品質指定をMCPへ最小公開する。egui Viewer全体の移植も、低解像度FullだけでDraftを代替する方式も前提としない。

前回のAは「desktopの適応Viewer制御全体を使う」、Bは「GenzoRoomが候補1280pxと高解像度の要求を出す」を主に比較していた。今回の推奨は**Bの操作所有権を維持しつつ、Aで利用したいnative RenderJob／geometryを小さなMCP APIで公開する構成**であり、A／Bの二択ではない。1280は不要な固定条件、4096は最終的な細部表示限界として扱わない。品質は常にDraft／Fullの2種類で、解像度・全体／windowは独立した要求属性とする。

### 12.1 Draft／Fullで何が変わるか（追加確認した事実）

| 処理 | 確認結果・根拠 |
|---|---|
| quality自体 | `RenderJob::draft()`はrequestのqualityとjob keyだけを変更する (`media.rs:785-792`)。通常`render_job`はFull、同じmax_w/max_h、before、cropでjobを作り、その後Draftにできる。`.draft()`によるsource level／寸法／設定値の変更はない |
| toneの空間処理 | `pipeline/src/local.rs::plane_sigmas:491-502`でtone有効時のbase sigmaをDraftは24以下にする。CPU `prepare:522-567`、GPU `gpu/src/render.rs::prepare:859-885`とも同じsigma計算を利用。従ってGPUにもDraftの意味があるが、すべての段階を省略する品質ではない |
| NR変更中の近似 | `pipeline/src/lib.rs:582-591`はStageCacheのpre-NR keyが一致するDraftに限って既存の広域planeを再利用。`local.rs::Planes::for_other_nr:413-436`はkeyを0にし、Fullがその代用品を一致cacheとして採用しない構造。StageCacheなしの最小MCP変更だけではこの継続cache最適化は得られない |
| Fullへの復帰 | CPUのbase planeはsigma／process／detail radiusで識別 (`local.rs:439-455,532-546`)。GPUも`local::base_key`を利用 (`gpu/src/render.rs:862-879`)。qualityフラグだけを独自変更して近似結果をFullと呼ぶ必要はなく、`.draft()`と通常jobで既存の再計算条件を使う |
| HDR histogram | `pipeline/src/lib.rs::hdr_histogram:499-518`はDraftでは追加HDR histogram描画を行わない。通常SDR画像のhistogramまで常に省略するという意味ではない |
| 最終画像cache | `RenderJob::run_photo` (`media.rs:977-995`) はview cacheへFullのみ保存。通常`render_job`はthumbnail result cache／view cacheとも無し (`1251-1269`)。Draft／Fullでsource cacheは共有でき、qualityだけで別RAWをdecodeする必要はない |

差が出る処理が無い設定／寸法ではDraftとFullが同じ画素になる場合があり、常に速い／見た目が必ず変わるとは断言できない。NRやsharpenを一律OFFにする、JPEG圧縮率で品質を代替する、といった独自近似は不要。

既存回帰の根拠：`pipeline/src/tests.rs::drafts_keep_wide_planes_across_a_noise_reduction_change_and_full_renders_do_not` (230-255) はDraftの再利用と最後のFullの正確さを検査する。本追加調査ではテスト本文を参照しただけで実行していない。

### 12.2 MCP品質指定の最小変更案（未実装）

例として`quality?: "draft" | "full"`（省略は従来Full）を`render_preview`へ追加する。以下は変更箇所の評価であり、パッチ・API仕様の確定ではない。

1. `crates/mcp/src/tools.rs::helper_tools`のschema (116-126) → `call_tool`の`render_preview`引数抽出 (620-625) → `render_photo` (502-524) → backend `ui.render`へqualityを転送する。legacy `render_photo`を共用するなら、そのschemaにも指定を追加するか公開対象を明示する。`check_args:394-413`は未知key検査でありenum／型の完全検証ではないので、未知文字列・boolean・null等を明示拒否する必要がある。
2. `crates/mcp/src/headless.rs::Headless::render`（本家52-57、既存Before patchの同hunk）で、品質指定を検証し、`Session::render_job(id,size,size,before,true)`を作る → Draft時だけ`.draft()` → `job.run()` → `session.accept(&result)` → imageを返す。After側も同APIを使えばBeforeと共通化可能。既存Full Afterは`render_now`が行うのと同じjob/run/acceptの意味を維持する。Engine／pipeline／GPUアルゴリズムの変更は不要。
3. 管理patchが追加済みのBefore fingerprint／effective fingerprint／geometry／kindを維持し、応答には実際に適用したqualityを確認できるmetadataを追加する案。schema capabilityを世代ごとに検査し、Draft非対応の旧binaryへ要求を黙ってFullとして通さない。`--connect` backendは別契約であり、quality未対応時は明示拒否が必要。今回の最小対象はGenzoRoomが使うheadless。

Beforeも同じ`RenderJob`なのでDraft／Full両方を指定できる。native `beginInteraction/endInteraction`を品質切替のためだけに呼ぶ必要はない。これらはnative History集約にも影響するため、C4のHistory境界を品質APIで代替しない。

**cache／sourceとの関係：** `build_job`でサイズ・crop等に応じたsource選択を終えてから`.draft()`を付けるため、Draftでも要求が大きい／cropが狭いならFull sourceを読む。qualityを下げても原寸sourceのメモリが減る保証はない。§4.2のSourceLevelは引き続き品質とは独立。MCPに結果cacheを加える場合はquality／before／寸法／window／settings／content等を分離し、同revisionのDraftをFull要求のhitとして扱わない。

**任意の追加最適化：** `RenderJob::with_stages(Arc<StageCache>)` (`media.rs:847-851`) を使い、HeadlessがAfter／Before／window等のviewごとにcacheを保持することは可能。これはDraftへ到達するための必須条件ではない。`Headless`の現行状態はSessionとprogressのみ（本家`headless.rs:13-17`）。追加時はphoto／generation切替、geometry／source変化、予算・破棄条件を持ち、無制限なwindow単位cacheを作らない。既存native cache key／GPU extensionを使い、GenzoRoom Pythonに現像段階を移植しない。

**既存patchへの影響：** `0001-native-before.patch`の`tools.rs:118,514,618`と`headless.rs:53,140`付近を新品質公開が共有する。単純な別patchの重ね掛けが常に成功するとはいえない。将来実装時は既存patchに統合するか順序付き追加patchを管理し、manifest digest／実binary SHA-256 receipt／capability probeを更新する（`native/lightcraft/build.py::probe/receipt:62-115,131-152`、`UPDATE_GUIDE.md`）。既存Before契約と省略Full互換は維持する。今回はpatch、manifest、build script、receiptを一切変更しない。

### 12.3 連続Draft、Draft→Full、処理中Fullの制約（事実と案）

**事実：** headless MCPはdesktop JobPoolではなく同期`Backend.call`。`mcp/src/progress.rs:109-136`のserver loopは1要求を処理してから次へ進む。GenzoRoom `LightCraftMCP.request` (`backend/lightcraft_mcp.py:183-203`) もlockを応答受信まで保持する。品質引数を追加しただけではpriority／latest-wins／計算中断は増えない。

- 全Draftを送信済みにすれば送信順に処理される。Fullが来ても処理中Draftが終了するまで待ち、既に先行する要求も勝手には消えない。
- 処理中Fullのあとに新しい編集Draftを要求しても、Fullを追い越せない。古いFullの応答を表示しないことと、その計算時間を回収することは別。
- adapterは既存のAfter pending 1件・Before別pending、After優先を持つが、HTTP After待機lock／Frontend owner queueが先に直列化しているため、Frontendで並行fetchを始めるだけでは集約を活用できない (`windows_raw_api.py:161-162,258-278`、`lightcraft_raw.py:917-1055`、`rawControls.ts:33-78`)。

**最小方針案：** 送信前の描画intentを集約し、編集中は最新Draft、確定後は最終ACK済みrevisionのFullを1件だけ残す。未送信Fullは新編集で無効化する。送信済みjobは所有者が完了を回収し、古い結果を採用しない。quality変更でsettings revisionを増やす必要はないが、`renderSerial`等を別に進める。要求identity候補はdocument owner／generation／native revision／quality／size／geometry／view generation（window時はfull frameと矩形も）である。

同revisionにDraft→Fullがあるため「revisionが変わらないなら再描画しない」は不可。新たな編集に対して古いFullを優先するのも不可。一方、同一表示intentのFullを受け入れた後に、その古いDraft完了で上書きしない。これはrequest sequenceと品質の照合で保証する案であり、新しい永続状態ではない。

単一同期MCPのまま、送信済みFullが全ての後続native操作を一切待たせない保証はできない。長いFullを避ける解像度／window選択、未送信要求の集約で負担を抑える。真のpreemptionは別のnative協調cancel等が必要で、最小qualityパッチには含めない。`asyncio.cancel`／timeoutで毎回sessionを破棄する方式は採らない（既存の送信後abort動作は§8）。

## 13. 追加調査：品質と独立した解像度／高画素RAW

### 13.1 表示に必要な画素数と再利用（事実・計算案）

**事実：** LCの`region::plan`、`AppSettings::loupe_edge/window_frame_edge`、`window_for`は§3のとおり既存の計算処理。`region.rs`は公開module (`ui-egui/src/lib.rs:35`) だが`ViewSizes`の計画は`crate::state::AppSettings`を受け、同ファイルにはegui型を受ける関数もあり、`ui-egui/Cargo.toml:6,25`はL5／egui依存を持つ。「そのままheadless Engine APIとして使える独立crate」ではない。`RenderJob`／`region_job`はEngineで既に独立している。

**計算案：** Viewerの実画像rectをCSS pixelで`R`、実測DPRを`d`、現像後の論理native frameを`N=(Nw,Nh)`とする。必要な全体出力長辺は`min(max(R.width,R.height) × d, max(Nw,Nh))`を基礎に、丸め／資源予算／source capで選ぶ。Fitはpaneに収まるrect、拡大時はzoom適用後のrectを使う。physical 1:1は`R.width × d = Nw`が基準。倍率はPreview PNGのnaturalWidthではなく論理native frameに対するものとして定義し、DPRを二重乗算しない。Browserのpage zoom／Windows scaling下では実測DPR・rectを使う。これはFrontend接続案で実機未確認。

全体画像方式ならこのサイズで既存Full／Draft jobを要求すればよく、固定1280や常時原寸は不要。Draft時だけさらにscaleを下げることは可能だが、品質と解像度のpolicyを混同しない。同じ寸法のDraft→Fullも有効である。LCの64px丸め、native cap、256px grid、margin、size holdを再利用候補とする一方、16ms／0.6の適応はdesktopの表示frame観測を前提とするため、MCP往復時間にそのまま当てはめない。

**再利用の選択肢：** 全体サイズの基礎計算だけなら既存Frontendの`viewerMath.ts::calculateFitScale/zoomAroundPoint` (6-23) と表示rectから求め、現像geometryはLCから取得するのが小さい。desktopと同じwindow計画が必要になった時は、`region::plan/window_for`と必要な上限定義をRustのUI非依存helperへ切り出し、egui／headless双方から呼ぶ案を優先する。これはLC側の局所的な構成変更であり最小quality公開には不要。PythonとTypeScriptに同じplannerを別々に再実装する案や、MCPがegui Viewer全体を保持する案は推奨しない。

`pipeline::native_output_size` (`pipeline/src/lib.rs:226-229`) と`geometry::Frame::native_size/fit` (`geometry.rs:178-195`) は既存計算。ただし`native_output_size`は`Frame::new`で、実現像の`frame_for` (`lib.rs:232-239`) は埋込lensとautomatic CA等を扱う。公称sensor幅／高さだけからGenzoRoomがframeを推測するのは避け、LCが使用した設定・geometryに対応するnative寸法／aspectと実出力寸法を返す必要がある。desktopも`Frame::with_lens`から`output_px` (`detail.rs:245-248,470`) を得ている。geometry metadata公開は現行MCPには不足している。

### 13.2 全体画像方式の範囲と4096超（評価）

全体描画方式はFitと中程度の拡大だけでなく、**出力全体がnative寸法を保持でき、予算内なら等倍表示にも使える**。現行`render_preview`の4096clampを超える公開サイズが必要だが、これはEngineの細部限界ではない。headlessには既に16384clamp、EngineにはFull source＋任意boxのjobがある。全体上限の緩和にはpixel数／PNG／MCP line／Pillow／Frontend／GPU buffer／一時画像保持の予算を一体で扱い、巨大無制限要求を受けない。16384も全RAWの普遍的な上限／対応保証ではない。

既存PoCのPentax DNGは現像後5472×3648 (`GPU_POC_V0.10.0.md`)。この寸法の全体Fullを取得できれば細部を等倍で表示できる見込みがあるが、4096画像を単に5472相当に拡大するだけではその細部は得られない。より高画素のPentaxを含む未検証素材でも、crop／orientation後のnative frameを基準に同じ判断をする。

例の5472×3648（19,961,856 pixels）だけでもRGBA8一枚76.15MiB、RGB32f一枚228.45MiB（概算）。Before／After、GPU／CPU中間、decode／転送が重なるpeakはさらに大きい。現行5MiB PNG／8MiB JSON lineでは全体原寸を安定返却できる保証がない。画素数が増えると原寸全体のencode・decode／転送がviewportとは無関係に増えるため、全体方式の成否は実機測定で判断する。

**領域描画を選ぶ条件：** 必要な物理解像度が保持する全体画像を上回り、全体サイズ拡大が時間・メモリ・転送・texture等の予算を超える場合。LC desktopの`frame_edge > main_edge × 1.25`は既存切替policyとして再利用候補であり、4096超だから常にROI必須という条件ではない。高画素RAWの等倍要件を全体方式で満たせなければ、領域描画を省略して等倍対応済みとしない。

### 13.3 region_jobの公開範囲（事実と最小API案）

**事実：** `Session::region_job/region_job_before` (`media.rs:1421-1442`) は`id, full_w, full_h, PixelWindow, apply_crop`を受ける。返ったjobへ`.draft()`を付けられるため、全体／windowとDraft／Fullは組合せ可能。`region_job_of:1444-1476`は`render_job`を基に、spot／Auto Mask read範囲を検査し、windowをrequestとkeyへ加える。

`PixelWindow` (`pipeline/src/lib.rs:152-171`) の座標はsensorの未回転座標ではなく、crop／straighten／flip等を反映した**最終出力frame内のpixel座標**。`pipeline::plan:395-443`は実際にfitしたfull_w/full_hにclampし、frame.windowを作り、空間効果のscaleは全体サイズを維持する。dehazeでは384px proxyから全体airlightを求め、spotで必要なら作業領域を拡張し出力を要求矩形に戻す。`geometry::Frame::window:123-140`がflipを含む座標変換を持つ。部分画像を普通のcrop画像として現像する実装は不要であり、そうするとradiusやvignette等が一致しない。

**API案（未確定）：** `render_region`等として、`id/before/quality`、仮想full frameの寸法、可視矩形（またはmargin込みwindow）を受け、既存region jobを実行する。qualityの共通処理は§12.2を使う。4096clampを仮想frameへ適用せず、仮想寸法と返却tile pixel数／spanに別の上限を設ける。validated integer／finite座標・checked演算・上限を境界で検証する。

必要な返却metadataの候補：source／document／revision identity、実quality／before kind、native frame寸法とaspect、実際にfitした`fullWidth/fullHeight`、返却windowの`x/y/width/height`、画像実寸、geometry identity（crop／orientationに加え実際のframeに影響するlens／transform等）、Beforeの既存fingerprint。要求boxと実際のframeが異なるとclamp座標も変わるため、受信側は実frameと返却windowに基づき配置する。原寸センサー値から矩形を組み立てない。

windowにmarginを付けて現像し、Viewerはその内側の必要領域だけ表示する。`region::window_for:336-362`は可視範囲の拡張・snap・frame内clampを既に持つが、最大spanを超える場合は中央寄せで切る。極端なviewportで一枚が全可視範囲を覆う保証はない。初期は覆える範囲へ制限するか、必要時に複数tile化する判断が必要。margin／画質の保証は既存テスト範囲を超えて断言しない。

`region_job`の`None`は必ずしも写真欠落ではなく遠距離readによる拒否も含む。MCPは拒否を構造化して返し、全体画像を維持する／予算内の全体描画へ戻る必要がある。無条件の巨大原寸fallbackは避ける。BeforeとAfterでlens／optics基準が異なる可能性もあるため、同じcrop／orientationだけでtile geometryが必ず同一になると仮定しない。

既存検査根拠（今回未実行）：`media.rs::one_to_one_window_pixels_are_export_pixels:2196-2224`、`pipeline/src/tests_window.rs:24-59,72-82,138-145,182-209,348-376`（全体との比較、margin内、NR／mask／spot等）。CPU／GPU差、DNG機種差、全設定でのpixel完全一致を保証する記録ではない。

### 13.4 高画素RAWのコストとViewer接続（案・未検証）

window renderは出力の原寸全体bufferを避ける。**原寸source全体のdecode／保持／GPU uploadもROI化する機能ではない**。§4.2のFull sourceは残り、GPUのsource共有やstage再利用も効果を左右する。`docs/gpu-pipeline.md:293`は大sourceをview間で共有する設計を記録しているが、MCPへの最小region公開だけでdesktopの寿命管理が全て得られるわけではない。source／stage cacheの予算と破棄、After／Beforeの重複decode抑制も確認対象。

Viewerは小さな全体画像を背景に保ち、tileを共通論理frameの矩形へ重ねる方式がLCに近い。pan／zoomではgeometryを変えずview generationを進め、同一snap windowを再利用し、画面外／古い倍率のtileを不適切に重ねない。photo／session切替では別ownerとして無効化。crop／orientation／lens／History復元等でframeが変わればgeometry generationを更新し、旧tileを即無効化する。

品質交換・全体画像の解像度交換はdocument identityや論理native frameを変えず、zoom／panを維持する。現在の`ImageViewer`はPNGのnatural sizeを表示尺度に使うため（§9.3）、この論理frameと取得bitmap寸法を分離するFrontend変更が必要。物理等倍と既存Preview pixel等倍の意味を混同しない。Beforeも同じ論理基準で配置し、quality／resolution／window／geometryをcache keyへ含める。tileが準備中は全体画像を維持するが、Before欠落時にAfterをBeforeとして表示しない。

## 14. 追加調査：C4操作・保存との接続

### 14.1 表示品質を操作境界へ接続する案

| 契機 | 現行の所有者・追加する表示intent（案） |
|---|---|
| pointer開始／変更／終了 | `RawAdjustmentControls.tsx:49-57` → `useRawDocument.ts:381-385` → `RawRecipeSave.begin/change/end:134-155`を維持。開始で未送信Fullを無効化、ACK済み中間値のDraftを集約、終了意思を記録して最終ACK済みrevisionへFull |
| 数値／keyboard／wheel | `AdjustmentSlider.tsx:73-154`のbegin／commit（Enter／Escape／静止timer等）を利用。pointer releaseだけに依存しない。Escapeで元値へ戻す現行C4の意味も保持 |
| カテゴリON/OFF・Reset | `RawRecipeSave.operate:62-77,sendMoveIntent:109-133`の既存操作・History ACK後のsettingsへFull。連続gestureでない単発操作のため無理にDraftを1枚挟まない |
| Undo／Redo／History jump | `move:49-60`は既存gesture commit→moveのfenceを持ち、`sendHistory:235-263`でnative／DB整合を検証して`controls.refreshPreview()`。復元後Fullを新revision／geometryとして要求、移動前のDraft／Fullを無効化 |
| 同revision Draft→Full | settings／Historyは更新せず、描画request identityのみ進める。現行`RawControls.flush`はpending空なら終了するので、品質更新の契機を別に渡す必要あり |
| Before/After | import基準とkind/fingerprint検証を維持。Before cacheにqualityも加える（現行の描画属性はmaxSideのみ、source等の基準identityも含む。§9.2）。同geometry・同寸法を基本とし、両側同品質を要求するかBefore Full固定を許すかを明示。Full Before固定はdesktop全体Beforeに近いが、Draft Afterとの差を画像補正差と取り違えない表示／評価が必要 |
| RAW切替／再生成／離脱 | `useRawDocument.ts:150-194,248-269,340-362`のsave→release→openとowner queueを維持。未送信描画を破棄し、送信済み描画は旧所有者が回収。新generationへ旧cache／tileを渡さない。画面から不要な画像URLは解放する |

`gesturing`はHistory ACKまでの状態と保存operationの有無を含む (`rawRecipeSave.ts:45,153-155,255`)。描画品質はこれをそのまま使用せず、操作終了の意思・確認済みnative revision・view intentを組み合わせる。§9.1の指摘をDraft／Fullにも適用する。

### 14.2 保存を描画完了待ちに結び付けない範囲と限界

**現行の事実：** `RawControls.flush`はPreviewをawaitしてbusyを下ろす (`rawControls.ts:63-78`)。`RawRecipeSave.save`は同queueの後ろへ保存処理を置き、`sendHistory`はcontrols.unsettledを拒否、native／SQLite／receipt整合を検証する (`166-184,221-269`)。HTTPの`_execute`とAfter `_preview`は同じadmission lockを使い、adapterもnative操作とPreviewに同じlockを使う (`windows_raw_api.py:161-162,258-278`、`lightcraft_raw.py:476-499,992-1034`)。Frontendのawaitを外すだけでは保存が止まらない保証はできない。

**最小案：** mutation ACK／settings readback／History・保存receiptを待つfenceと、PNG decode／表示反映を待つfenceを分離する。描画intentは表示専用の状態とし、Full完了をDB保存の成功条件に追加しない。未送信Fullより確定mutation／保存／移動を優先し、native read-only renderを開始する前に現在revisionを検証し、応答後もrevisionとrender identityを再検証する。

これは新しい独立native Sessionを作るという意味ではない。native送信は引き続き単一所有者で直列化し、送信済みjobの回収／release barrierは保つ。HTTP lockを待機中に解放するならownerのsnapshotと応答時検証が必要で、mutationとrenderのreadbackを無保護に並列化しない。SQLiteへの保存で必要な現行native同期確認を省略したり、古いsettings snapshotだけで保存成功にしたりしない。既存`_previews`のAfter settings readbackでrevisionが変化する可能性も保持する (`lightcraft_raw.py:1011-1015`)。

**限界：** 単一同期MCPで既にFullを実行中なら、保存に必要なnative確認がその後ろで待つ可能性は残る。既存CAS／receipt保証を保ちながらこれを完全ゼロにすることは品質引数だけでは達成できない。まず不要な表示decode待機・未送信Full待機を除き、実行時間は表示依存サイズ／必要時windowで抑える。独立worker／不変settingsを持つ非同期job／協調cancel等は測定後に必要と判明した場合の別範囲であり、最初から必須化しない。

**永続契約：** `backend/edit_store.py:14`のschema v8、`raw_recipe_store.py:232-291`のCAS／save receipt、`HISTORY_LIMIT=200` (`294`)、`RawRecipeSave.sendHistory:235-269`のACK・cursor・fingerprint・unknown retryを変更しない。quality／viewport／window／render sequenceはRecipe、History step、saveId、永続fingerprintの入力にしない。表示再生成だけでHistory操作数やnative mutation試行数を消費しない。新機能でも既存C4-F完了記録は維持する。

## 15. 最小変更範囲・実装順序の再評価（未実装）

次の3区分は技術範囲の比較であり、品質を3段階にするものでも、工程開始の承認済み計画でもない。

| 範囲 | LC Engine／pipeline・UI helper | LC MCP／管理patch | GenzoRoom Backend | GenzoRoom Frontend |
|---|---|---|---|---|
| 1：明示Draft／Full | 現像処理変更不要、既存`render_job/.draft/run/accept`使用。stage継続は追加最適化 | quality schema・検証・転送・headless job選択、実quality応答／capability。Before patchと統合、probe／receipt追随 | runtime引数／schema能力検査、ticket／cache／PNG metadata検証にquality追加。同revision切替と所有権・集約、保存と描画待機の整理 | C4操作境界からDraft／Full intent、同revisionでもrequest serial更新、古いFull排除。比較品質と表示失敗の扱い |
| 2：表示依存の解像度 | native frame計算を再利用。desktop plannerの厳密共用が必要なら純計算部分だけ切出す（必須ではない） | max_sideとqualityを独立、native／実geometry寸法を公開。4096超を全体方式で扱うならclamp・pixel予算と応答経路を拡張 | HTTPサイズ入力／広告／上限、pixel／PNG／Base64／line／validation予算、サイズ別Before key。巨大応答経路は測定で選択 | viewport／DPR／zoomの測定、logical frameとbitmap分離、zoom/pan保持、サイズ変化の要求集約 |
| 3：高画素等倍で必要時ROI | `region_job/_before`、`PixelWindow`、既存frame／window／margin計算を再利用。source全体decodeは残る | region API、仮想frameと返却tileの別上限、拒否・quality・座標／geometry metadata。必要ならstage寿命管理 | tile要求／cache／最新view照合、After優先・Before整合、部分画像のpixel／byte予算 | 全体画像＋tile配置／clip、pan/zoom再要求、geometry変更／photo切替で旧tile無効化 |

**推奨順序：** 最初に1のnative品質公開とC4表示intent／保存待機の境界を小さく成立させる。最小検証では既存サイズを使ってqualityの効果を解像度変更から切り離せるが、1024pxを製品の最終上限にする意味ではない。2の全体サイズ選択・geometry公開・表示尺度修正は1と共通するrequest identity／cache／比較契約が多いため、実装時に一つのまとまりで行う方が単純なら分割を強制しない。初期からdesktop適応planner全体やtile合成を持ち込まない。

高画素等倍は**全体原寸が予算内なら4096超の全体Full公開で成立させ、予算外なら3のregion APIを追加する**。全体方式に固執して無条件に巨大PNG上限を上げることも、等倍要件を4096で打ち切ることも推奨しない。native Draft／Full＋表示依存の要求制御を基本構成とし、regionは等倍要件と実機予算から必要性を判断する。GPU／CPUの現像式、source level選択、空間効果、Before基準はLCを再利用し、GenzoRoomでは再実装しない。

### 15.1 未確認事項・将来必要な測定

- Draft／Fullの同寸法比較（tone／NR／WB／各C4 control、CPU／GPU、cold／warm）。StageCacheなし／継続ありでどの効果が得られるか。Draftだから一定の高速化が得られると仮定しない。
- 画面rect／DPR／zoomを変えたE2E遅延。nativeだけでなくencode・MCP・validation・HTTP・decode・表示まで測定し、連続Draft中の最終値Full到着時間、処理中Full後の新編集の待機時間を含める。
- Pentax等の4096超DNG／さらに高画素素材で全体原寸とwindowを比較。pixel実寸、細部、NR／sharpen／dehaze／lens／crop／orientation、tile境界margin、GPU fallback、source再decode／upload、CPU RAM／VRAM peak、PNG容量を確認。
- 全体画像・Before・tile・旧画像の同時保持、byte上限超過時の可視エラー／回復、window拒否とfallback。現行5MiB／8MiBのままで大画像を保証しない。
- 同revision Draft→Full、新編集vs Full、pan/zoomとHistory移動、カテゴリ操作、写真切替・再生成・離脱、保存失敗Retry／CAS／unknown receiptとrender完了の競合。qualityが永続状態／History 200操作／native mutation budgetへ影響しないこと。
- 最小パッチ実装後には省略Full／Before後方互換、enum誤入力、実binary capability／quality echo、patch順序・digest・receiptの検証が必要。今回これらのパッチ適用・build・probe・テストは実施していない。

本追加調査の実施範囲は既存資料の読込み、上記差分の静的追跡、文書の整合確認、`git diff --check`のみ。変更対象はこのMarkdown1件。LCソース・GenzoRoom製品コード・MCP patch・SQLite／Recipe／History・C4完了記録・README／CHANGELOGは変更せず、ビルド・実機試験・ブラウザ確認は行わない。文書のみCommit／Pushして停止し、実装へ進まない。
