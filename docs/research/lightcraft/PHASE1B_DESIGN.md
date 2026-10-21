# RAW現像統合 Phase 1B 実装前調査・設計

調査日：2026-10-21（Asia/Tokyo）。**本書は未実装の設計提案**である。LightCraftソース上の事実、GenzoRoomの既存実装、今回推奨する変更、実機未検証事項を区別する。Phase 1Aの設計・完了記録は変更しない。

## 1. 調査基準・範囲・確認ソース

| 項目 | 調査時点の基準 |
|---|---|
| GenzoRoom | `I:\code\genzoroom`、`feature/lightcraft-integration` |
| 調査開始時HEAD | `f363952363533f9b1e4e74f9aaaeda8847b75057`、作業ツリーclean |
| Phase 1A実装／監査後修正 | `8cf74987d509620434942b00598144879068312e`／`5a9e0f977579a27cd4131ec2034f0ad156519aae` |
| LightCraft | v0.10.0、`a2a41383c4fd62fa85a46ccd00998639221f2d3c` |
| 参照worktree | `I:\code\raw-test\lightcraft-v0.10.0-gpu-poc`。HEAD一致・cleanを確認。元のv0.9.1 checkoutは変更していない |
| 対象 | Windowsネイティブ版Python Backend内部。Python 3.14、Windows 11／RX 580 |

[資料索引](README.md)、[Engine API](ENGINE_API.md)、[統合案](INTEGRATION_DESIGN.md)、[v0.10.0差分](V0.10.0_CHANGES.md)、[GPU PoC](GPU_POC_V0.10.0.md)、[Phase 1A設計・実装結果](PHASE1A_DESIGN.md)、[architecture](../../architecture.md)、[開発記録](../../development-notes.ja.md)を参照した。ENGINE_APIの旧版行番号をv0.10.0の証拠として流用せず、下表の固定commitの実装を確認した。

主要な根拠（LightCraftパスは上記worktree相対、行番号も同commit）：

| ソース・関数／行 | 確認した事実 |
|---|---|
| `crates/mcp/src/tools.rs:17` `ToolResult`、`:433` `activate`、`:440` `temp_path`、`:447` `image_result`、`:502` `render_photo`、`:620`以降のtool dispatch | structuredContentとimage contentの違い、Previewと一時PNG、command_run、import helper |
| `crates/mcp/src/headless.rs:30` `Default`、`:55` `render`、`:120`以降の`Backend::call` | filesystem付きメモリ内Session、同期render_now、ui.renderと一時画像書込み |
| `crates/mcp/src/server.rs:95` `handle_line`、`crates/mcp/src/progress.rs:1`／`:55` `serve_stdio` | JSON行応答、serving threadでの同期実行、Previewの途中cancel保証がないこと |
| `crates/engine/src/cmd/library.rs:619` `library.select`、`:884`以降のdelete、`:1523` `library.import`、`:1606` `library.clearPreviews` | 選択、登録、解放に使える操作と制限 |
| `crates/engine/src/import.rs:1`、`:194` `ImportReport`、`:758` `import_with`／`:484` `probe_paths`、`files.rs:1062` `fs_hooks` | path／content重複、import report、sidecar読込み、probeとdecodeの分離 |
| `crates/catalog/src/model.rs:10` `PhotoId`、`:225` `Photo` | u64識別子、RAW kind、content_hash、preview_only |
| `crates/engine/src/cmd/query.rs:10` `photo_summary`、`:154` `photo.inspect`、`:170` `develop.get`、`:183` `develop.controls`、`:238` `library.memory`、`:241` `app.memoryBudget` | RAW判定、設定取得と明示process、control値、メモリ照会と予算変更 |
| `crates/engine/src/cmd/develop.rs:159` `develop.set`、`:248` `develop.merge`、`:1135`以降interaction | control変更、部分JSON適用、操作中と確定の区別 |
| `crates/develop/src/lib.rs:37` `from_json`、`:45` `merged`、`:63` `keep_in_range` | JSON merge、WB scale互換、範囲補正 |
| `crates/develop/src/settings.rs:1`、`:23` `ProcessVersion`、`:104` `DevelopSettings`、`:279` `WbScale` | 未知field、欠落値、process V1/V2、WB意味 |
| `crates/develop/src/presets.rs:142` `deep_merge`、`controls.rs:157` `set` | object再帰merge、配列等の置換、control clamp |
| `crates/engine/src/lib.rs:542` `run_command`、`:594` `commit`、`:726` `apply_silent`、`:882` `set_develop`、`:941`以降interaction | journal／Undo／History保持、interaction中の一時適用 |
| `crates/engine/src/media.rs:87`以降のbudget／SourceLevel、`:414` `MediaCache::default`、`:466` `clear_sources`、`:614` `forget`、`:1206` `build_job`、`:1550` `accept`、`:1581` `render_now` | ソース寿命、解像度、cache、decode後のWB情報、StageCacheなしのMCP |
| `crates/engine/src/media.rs:1015`以降 `develop_reporting`／`develop_image`、`memory.rs:25` `default_budget`、`sidecar.rs:53` `XmpPrefs` | GPUとCPU fallback、予算とRSSの違い、auto_write既定false |

GenzoRoomでは`backend/lightcraft_mcp.py`全体、`backend/lightcraft_runtime.py`のsession owner／cleanup／public操作、`backend/windows_local.py::LocalHost` lifespan／`main`、`backend/tests/test_lightcraft_mcp.py`、`test_lightcraft_runtime.py`、`test_windows_local.py`の関連ケースを確認した。今回ビルド、テスト実行、RAW現像、MCP接続、GPU試験は行っていない。既存PoCの性能値・Phase 1Aの117件成功を今回の新規検証と混同しない。

Phase 1Bの到達点は、内部Python interfaceでRAW登録、設定取得・適用・readback、反復Preview、写真切替、明示Session再起動からの復元を扱えること。暗室UI、HTTP公開API、Recipe／History永続化、最終Export、Immich登録、Stack操作は対象外。

## 2. 現行Phase 1Aと再利用境界（確認済み）

Windows `LocalHost`外側lifespanは共通Backend lifespanに入った後で`LightCraftManager`を生成し、`backend.state.lightcraft`へ保持する。`start()`はowner taskを登録して戻り、handshake待ちはBackend readyをブロックしない。終了時はmanagerを閉じてから共通lifespanを抜ける。共通`main.app`／Dockerはmanagerを作らず、TauriはBackendの所有に専念する。`--check-runtime`もLightCraftを起動しない。

managerはexe検査・SHA-256、環境allowlist、DX12、generation、起動／監視／回収を所有する。MCP clientはLF区切りUTF-8 JSON-RPC、1要求直列化、ID照合、通知分離、lock待ち・送信・応答を含む期限を所有する。送信後timeout／cancelは接続を無効にし、自動再送・自動restartしない。protocol異常後のstdout排出、独立cleanup task、cancel済みexit watcherの再生成、回収不能時のrestart禁止は維持する。

現行`MAX_LINE_BYTES`とsubprocess StreamReader limitは1 MiB。`LightCraftMCP.call_tool()`はtool envelopeを検証した後に`structuredContent`だけを返す。このまま画像toolを呼ぶと、成功しても画像を取り出せない。RAW操作用のpublic interfaceや複数RPCをまとめる操作lockも未実装である。

## 3. RAW／DevelopSettings API（LightCraftソース確認済み）

### 3.1 RAW登録、写真識別、切替・解放

推奨するwire形式はhelperのフォルダ展開を使わず、1ファイルずつEngineコマンドへ渡すもの。Windows pathはJSON encoderに渡し、手作業でescapeしない。

```json
{"jsonrpc":"2.0","id":"1:3","method":"tools/call","params":{"name":"command_run","arguments":{"id":"library.import","params":{"paths":["I:\\code\\raw-test\\pixel\\sample2.dng"],"mode":"add"}}}}
```

- `mode:add`は原本を参照し、copy／moveをしない。`--library`は使用しない。importはファイルprobe・寸法／metadata／content hash登録であり、Preview用RAW decode完了を意味しない。
- 結果はobjectの`imported:[u64]`、`duplicates:[{path,existing,reason,...}]`、`failed:[[path,error],...]`等。import失敗が`failed`に入っていてもtool全体は`isError:false`になり得る。`imported[0]`の無条件参照は禁止。
- 同じpathはskip、同一内容の別pathも重複として既存IDを返す。再importは設定resetではない。同pathの中身を変えても単純な再importが新規decodeを保証しない。Recently Deletedに対するrestore／skip／freshもあり、Phase 1Bではこれを使わない。
- `PhotoId`はSessionのu64で、Immich Asset IDではない。新Sessionで同じ番号が再使用されても同じ写真と見なさない。
- `library.select {ids:[id],active:id,mode:"replace"}`で単独選択する。不在IDはエラー。切替時に`end_interaction()`が呼ばれる。`develop.set`／`merge`は基本的にactive photoへ作用するため、選択と変更を一体の操作として直列化する。
- `photo.inspect {id}`の`kind`、`preview_only`、寸法、content_hash等を検証する。preview_onlyがNoneならfield自体が省略される。`catalog.query`のsummaryでは`previewOnly`という別表記でnullも返す。preview-only RAWをRAW decode成功と扱わず、理由なしでも実decodeの成功証明とはしない。photo.inspectはmetadataや設定・履歴も含む大きい応答なのでimport直後の検証に限定し、反復Previewで全文取得しない。
- `photo.delete`はRecently Deletedへの移動。`photo.deletePermanently`はcatalog recordを除去し`media.forget`へ至るがUndo等に関連データが残り得る。原本削除用として使わない。`library.clearPreviews`はrendered cacheとdecoded sourcesをclearするだけでcatalog／Undoを消さない。確実なSession全体解放はプロセス回収である。
- importはsidecar／embedded XMPの設定を読む。既定`XmpPrefs.auto_write=false`、メモリ内Sessionでは設定変更を原本やsidecarへ保存しない。Phase 1Bもauto-writeを有効にせず、import初期値が常にneutralであるとは仮定しない。

### 3.2 設定取得・適用と確定値

すべて`tools/call → command_run {id:<command>,params:{...}}`で呼べる。

| Engine command／params | 実装上の意味 |
|---|---|
| `develop.get {id}` | 設定object。`process`をV1でも明示。明示した不在IDはqueryの入口でエラー。adapterはobject以外の応答も防御的に拒否する |
| `develop.controls {}` | control ID、範囲、default、現在値。配列結果なのでToolResultのstructuredContentには入らずtext JSONとなる |
| `develop.set {values:{"light.exposure":0.5}}` | control IDへの絶対値設定。**設定全体の置換ではない**。未知control／非数値はエラー、既知controlはspecの範囲へclamp |
| `develop.merge {settings:{light:{exposure:0.5}}}` | 現在のDevelopSettingsにobjectを再帰merge。指定のないfieldは保持し、配列・scalar等は置換。serde読込み後に共通範囲補正 |
| `develop.reset {ids:[id]}` | import look／camera defaultsへresetし、processも最新へ。中立JSONへの置換とは異なる |
| `develop.beginInteraction {label:"Edit"}`／`endInteraction {}`／`cancelInteraction {}` | 一時適用／1 Undoとして確定／開始時へ復元。GenzoRoom Historyとは別物 |

`develop.set`／`merge`の成功結果は原則`{ok:true}`であり、新しい全設定を返す契約ではない。**選択→変更→`develop.get {id}`を1つのBackend操作とし、readbackの設定だけを確定値として保持する。** helper `set_develop`はcontrol変更後にmergeも実行できるが、返すのは`{ok:true,controls:[...変更対象controlの値...]}`であって全設定ではない。複数変更の途中失敗もtransaction rollbackではないため、Phase 1Bは明示的なコマンド列を使う。

MCPにはRustの`Session::set_develop(id, full_settings)`そのものに対応する全置換commandはない。Engineから取得した全snapshotの復元には`develop.reset`→snapshotを`develop.merge`→`develop.get`を使い、resetで一度変わるprocessもsnapshotの明示processで戻す。JSON欠落fieldまで旧値を消したい場合に、単独mergeを全置換と呼ばない。途中失敗は下記のdesynchronized扱いで、成功したように返さない。

全復元は同一engine基準で取得したsnapshotだけを受け、processとWB scaleを正規化した意味上の設定比較を行う。clampや未知field落ち等で一致しなければ`raw_restore_mismatch`としてdesynchronizedにし、黙って「元の設定へ復元できた」と扱わない。部分変更のreadbackで補正値を採用することと、全復元の一致判定は区別する。任意JSONを新しい永続schemaとして受け付けるAPIにはしない。

v0.10.0の`merged()`はcontrol範囲、point curve座標0..1、回転角0のcropの画像範囲への切詰めを行う。面積なしcropは変更前のrectへ戻し、それも空ならUNITとなる。回転cropには同じ切詰めをしない。例：過大Exposureは5.0、geometry.scale=0は50.0へ補正される。`from_json()`単体が同じ補正を保証するわけではない。

未知JSON fieldはserdeで無視され、往復保持されない。不正な型・enum等はエラーになり得るが、processは特別に寛容な読み方をする。Process Versionはschema `version=1`と別概念で、新規設定はV2、保存JSONで欠落・不正なprocessはV1、将来番号は番号を保持し当該buildの最新processで描画する。Phase 1Bは取得済みprocessを保持し、自動updateProcessをしない。

WBのtemp／tintをmergeしscaleを省略すると、元がKelvinでもLegacyへ戻る。`develop.set`の`wb.temp`／`wb.tint`はsource情報でnormalizeしCustom modeへ変更する別経路。設計ではWB control変更を優先し、JSON変更ならtemp／tintと`scale:"legacy"|"kelvin"`を必須の組として要求する。Engineが省略して返したLegacy scaleは内部snapshot比較時だけ明示Legacyとして正規化し、Engineへの全復元JSONにもscaleを明示する。JPEGの相対TemperatureやRecipe値への換算はしない。

通常の変更はLightCraft内部History／Undoを増やす。interaction中はcatalogへsilent適用され、end時に確定される。Phase 1Bの通常APIは1回ずつ確定させ、ドラッグ相当のinteraction APIは公開しない。将来UIの操作単位とGenzoRoom Historyの接続はPhase 1Cで別設計する。

## 4. Preview API・MCP画像・メモリ制約

### 4.1 確認済みの経路

```json
{"jsonrpc":"2.0","id":"1:7","method":"tools/call","params":{"name":"render_preview","arguments":{"id":1,"max_side":1024,"format":"png"}}}
```

`render_preview`は`max_side`を`render_photo`の`size`へ渡す。既定1024、16〜4096へclampされる。指定idで同期renderし、selectionは変更しない。出力はcrop後で要求した正方形内に収まる寸法。Draft、任意quality、stage cache、Preview途中cancelを外部指定する引数はない。

`Headless::render`→`Session::render_now`→job.run→acceptでソースをcacheへ受け入れる。初回はprobe済みでもdecode・線形RGBソース生成・GPU初期化が発生し得る。継続Previewはソースを再利用するが、MCPは`StageCache`を継続保持せず、同設定でも完成画像cache hitを保証しない。初回decodeがas-shot WB情報を更新する場合もあるため、設計ではPreview後にもgetでsnapshotを照合する。

ソースは主に線形Rec.2020の`Arc<Rgb32f>`で12 bytes/pixel。通常decode後の圧縮RAW／sensor配列は恒久保持しない。Thumbは512、Previewは2560、Fullは原寸。preview source既定最大4枚、Full既定1枚とcache budgetがあるが、強いcropでは1024出力でもFullが選ばれ得る。2560正方形float RGBは75 MiB、20 MP Fullは約229 MiBで、decode中間物・GPU bufferは別である。

Windowsの既定memory budgetはfallbackで1.5 GiB、主にcache等の配分値でありprocess RSS上限ではない。`command_run`経由の`app.memoryBudget {mb:1024}`で既存Sessionの配分を変更でき、`library.memory {}`はcache等のaccountingを返す。新しい環境変数や本体改修は不要。GPU失敗／非対応条件ではCPU pipelineへfallbackする。`ui.render`は`Rendered.image`だけを使うため、Preview responseにその要求のgpuFallbackは付かない。`app.gpu`のavailability／lastFallbackも全要求のGPU実行証明ではない。

MCP側はOS temp下に`lightcraft-mcp-<pid>-<counter>-render.png`を書き、`image_result`で読み、削除を試みる。PNGは8-bit画像、JPEG指定時はPNGをdecodeしてquality **88**で再encodeする。Preview qualityの指定は不可。削除結果は無視され、書込み・read失敗や強制killでは一時PNGが残り得る。`render_preview`にはpath引数がなく、helperは最終出力ファイルを保存しないが、一時ファイルまで存在しないという意味ではない。

成功結果の骨格：

```json
{"jsonrpc":"2.0","id":"1:7","result":{"isError":false,"content":[{"type":"image","data":"<Base64>","mimeType":"image/png"},{"type":"text","text":"{\"width\":1024,\"height\":770,\"id\":1}"}]}}
```

image_resultは`structuredContent`を設定しない。metadataはtext中のJSONで、通常pathは削除される。画像read／encode／render失敗はtool `isError:true`となり得る。任意のerror本文はpathを含み得るため診断へ転記しない。

### 4.2 推奨上限（未実装の初期policy）

Phase 1BではPNG、既定1024px、許可16〜1024pxに限定する。LightCraftの4096上限まで開放しない。JPEG利用・高解像度化は計測後の拡張候補とする。

| 対象 | 提案する上限／意味 |
|---|---|
| 通常RPC応答 | 現行1 MiBを維持 |
| PreviewのJSON-RPC行 | 8 MiB（LFを含む）。その要求だけに割当てる |
| 画像encoded bytes | 5 MiB。デコード前Base64長も`4 * ceil(5 MiB / 3) = 6,990,508`文字以下 |
| Metadata text | 16 KiB、object／id／整数寸法を検証。画像1個＋metadata1個だけを採用 |
| 画像展開 | 長辺1024以下、総画素1,048,576以下、単一frame PNG。RGBA展開最大4 MiB |
| 設定 | 入力patch 64 KiB、確定snapshot 256 KiB、最大depth32、finite JSON。上限超過は明示エラー |
| 保持数 | 実行中Preview1、最新待機ticket1、adapter内の完成画像cacheなし |

1024正方形の無圧縮RGBAだけで4 MiB。PNGは圧縮率に依存し、Base64で約4/3倍、さらにJSONとLFが加わるため、1 MiB行では安全に収まらない。5 MiB画像と小さいmetadataを8 MiB行内で受ける案であり、**圧縮画像が必ず上限内という保証ではなく、超過は拒否する**。

MCP clientに内部`call_tool_result()`を追加し、contentとstructuredContentを含む検証済みenvelopeを返せるようにする。既存`call_tool()`の返値とGPU取得は維持する。pending entryに応答byte budgetを結び付け、Preview要求時だけ8 MiBを許す。subprocess StreamReaderのtransport上限も8 MiBへ合わせ、readerでは通常要求／pendingなしの1 MiB検査を残す。大きいframeでもID照合・通知検証・違反後排出は変更しない。Preview待機中の通知も通知としての小さい上限を検証し、画像として扱わない。

行受信前のupper bound、JSON解析後のcontent数・型、Base64文字数、strict Base64 decode、encoded byte数、PNG signature／Pillow識別、header寸法、`verify()`と再open／`load()`、metadataとの一致を順に検証する。画像寸法はpixel展開前に判定する。既存Pillowを再利用し、JSON parse・画像検査はevent loop外へ。Pillowのglobal上限やJPEG rendererは変更しない。

line buffer、UTF-8文字列、JSON内Base64、decode bytes、検査pixel bufferが一時的に共存する。通常の1画像でも数十MiB、実装copy次第ではそれ以上のPython transient memoryを見込む。8 MiBはwire上限でありPython heap／RSSの8 MiB保証ではない。次のPreviewを送る前に解析・検査まで完了し、raw envelope／Base64／検査pixelを解放する。to_thread中のcancelでもworkerの完了・入力参照を追跡し、新しい検査を重ねない。呼出側が返却bytesを大量に保持することはこのadapterの保持上限とは別で、PoC側でも直前画像を解放する。

## 5. 推奨するPhase 1B構成・interface

追加モジュールは**`backend/lightcraft_raw.py`の1つ**とする。そこにLightCraft固有RAW adapterと単一Preview workerを置き、汎用plugin registryや先行したRust実装は作らない。

| 所有者 | 責務 |
|---|---|
| `lightcraft_mcp.LightCraftMCP` | framing、ID、要求直列化、request別byte budget、tool envelope。RAW／Pillowを知らない |
| `lightcraft_runtime.LightCraftManager` | process／generation／回収、generationを指定した内部command／Preview呼出し、session専用temp directory。RAW写真mapや編集revisionは持たない |
| `lightcraft_raw.LightCraftRawSession`（提案名） | sourceとphoto ID対応、settings readback、複数RPCの操作lock、revision／切替epoch、Preview集約、画像検証、内部error変換 |
| Windows `LocalHost` | managerとraw sessionを同じWindows lifespanで構成・所有。`backend.state.lightcraft_raw`へ保持。起動時にRAW importやGPU照会はしない |

raw sessionのpublic操作案（すべて内部Python向け、入出力は不変snapshot／bytes。型名は実装時に既存命名へ合わせる）：

```text
open_raw(source_key, absolute_path) -> RawHandle + DevelopSnapshot
select(handle) -> DevelopSnapshot
get_settings(handle) -> DevelopSnapshot
set_controls(handle, values, expected_revision) -> DevelopSnapshot
merge_settings(handle, partial, expected_revision) -> DevelopSnapshot
restore_settings(handle, engine_snapshot, expected_revision) -> DevelopSnapshot
request_preview(handle, expected_revision, max_side=1024) -> ticket
await ticket -> PreviewFrame | Superseded
reset_session(restore_active=True) -> RawHandle | None  # 明示的な回復／解放操作
close() -> None
```

`DevelopSnapshot`はsource_key、document token、generation、revision、engine version／固定commitの基準、全設定（明示process／WB意味）を含む。ただしcommitはhandshake検証済み値ではなく構成基準。`PreviewFrame`は同じ識別情報にselection epoch、request sequence、mime、寸法、encoded bytesを加える。Rust Adapterへの交換境界はこの意味上の操作と型に限定し、MCP tool名、base64、LightCraft photo IDを利用側へ露出しない。永続形式は決めない。

managerの内部操作はexpected generationとsession identityを送信前／返却後に検証し、旧操作が新clientを再取得しないようにする。raw sessionの操作lockはselect→set/merge→get、およびrender→検査→必要なgetを直列化する。MCPの1要求lockだけではこの複数RPC間のactive変更を防げない。ping／GPU queryは状態を変えないので必要ならRPC間に入れるが、別のRAW書込み経路は設けない。

## 6. 写真・Session・revision管理

### 6.1 共有状態と不変条件（設計案）

| 状態 | 所有・更新条件／不変条件 |
|---|---|
| process generation | managerのみ更新。raw handleはgenerationを捕捉し、MCP再起動後に旧photo IDを再利用しない |
| source map | raw sessionがopaque source_keyと正規化path、size／mtime、Engine content_hash、photo ID、最新確定snapshotを対応付ける。pathはメモリ内の機密値 |
| document token | open対象の論理寿命を識別する非再利用token。閉じて開き直した同じsource_keyでも旧応答を受け入れない |
| selection epoch | 切替受付時に増加する。RPC lock取得を待つ間も旧画像を無効化する。A→B→Aでもepochは別 |
| requested／applied revision | 編集受付時にrevisionを予約して旧画像を無効化。set/mergeとget成功後のみapplied revision・確定snapshotを更新する。送信JSONを確定値にしない |
| latest Preview sequence | enqueue時に増加。generation、token、epoch、applied revision、sequenceが全て現在値と一致する結果だけを返す |
| sync state | raw session独自のempty／loading／synced／applying／desynchronized／lost／closing。MCP managerのready／failedとは区別する |

`expected_revision`は適用時にも検証し、同じ基準から競合した変更を勝手に上書きしない。get／変更は明示handleを受け、activeと異なる写真を変更するにはselectを明示する。設定readbackがnull／不正ならsyncedにしない。readonly queryと取得snapshotはdeep copyまたはimmutable表現にし、callerのdict変更で正本が変わらないようにする。

### 6.2 最小PoCでの容量方針と選択肢

**推奨初期値はSession内RAW最大2枚、確定変更最大256回／generation。** 2素材間の往復で同一ID・ソース再利用を確認し、上限時は`raw_session_capacity`／`raw_session_edit_limit`として追加操作を拒否する。明示reset後に必要な写真を再importする。これはLightCraft仕様の上限ではなく、無制限のcatalog／History／pending log蓄積を防ぐPoC側の保守的な制限である。

raw sessionの最初のimport前、および明示reset後に`app.memoryBudget {mb:1024}`を適用する案とする。配分のreadbackは確認するが、1 GiBをprocess RSSのhard limitとしない。未設定でRAWを使わないPhase 1Aの起動経路ではこのcommandを送らない。snapshot mapとresident ID mapは別に持ち、reset時は全resident IDを破棄する。保持snapshotは最大2枚とし、容量超過を暗黙のsnapshot破棄で解消しない。

同じsource_key・同じfingerprintの再openは既存handleを利用する。file変更を検出したら既存cacheを黙って再利用せず、明示resetと再importを要求する。別source_keyが同じLightCraft IDへ重複解決された場合は独立編集対象として共有せず`raw_duplicate_source`を返す。別名pathやcontent重複を2つの独立設定として扱わない。

| 方式 | 利点 | 制約／判断 |
|---|---|---|
| 2枚保持＋容量到達時は明示reset | 同一Sessionでの再編集・写真切替が簡単。Phase 1Aの自動restart禁止を維持 | 3枚目以降を無制限に開けない。Phase 1Bの推奨 |
| 切替ごとにprocess再起動 | 全cache／Undoを解放しやすい | GPU初期化とdecodeを毎回負担。暗黙再起動は採用しない |
| deletePermanently＋cache clearでLRU | 常駐のまま多数の写真を巡回可能 | Undo／journal等までの解放保証が弱い。Phase 1C以降で計測・設計 |

file入力はローカル絶対pathの通常ファイル1枚に限定し、フォルダ再帰、UNC、device path、copy／move等は公開しない。metadata照合のOS I/Oもevent loopへ直置きせず、Phase 1A検査と同様に終了可能な期限付きworker管理を使う。size／mtimeは変更検出の補助で完全な内容同一性保証ではない。再import後にEngine content_hashも照合し、変更があれば保存snapshotを自動復元しない。

2枚／画像寸法上限はdecodeやGPUの総メモリをhard capしない。RAWのmetadataやsidecar、Fullソース・native allocationの影響は残る。実機PoCではRSS／PrivateUsageとlibrary.memoryを区別して採取し、無制限運用を受入条件にしない。

## 7. Preview集約と古い結果の破棄

Backend内でworker1個、実行中ticket1個、最新待機ticket1個を所有する。enqueue時に新sequenceを割当て、未開始の旧ticketは`Superseded`で完了し参照を解放する。実行中ticketはtask.cancelしない。画像応答を最後まで受信・検証した後、その時点で古ければbytesを渡さず破棄する。新しいPreviewの送信は前の画像検証完了後である。

1. ticketはhandle／generation／selection epoch／applied revision／sequenceを捕捉する。設定適用待ちのrevisionはまだrender対象にしない。
2. workerは操作lock取得後にcurrentを再検証してrenderを送信する。未送信のstale ticketはRPCなしで終了。
3. MCP結果、画像検証、post-render getが終わったら、manager stateと全tokenを再照合する。新しい編集が受付済みなら旧applied revisionの画像も返さない。
4. post-render getが変わっていた場合は、snapshotを更新しrevisionを進め、その画像はstaleとして破棄する。無限再renderせずcallerが新snapshotで要求する。確認したWB学習経路はcatalogのas_shot_wbを更新し、DevelopSettingsを直接書換えるものではない。getの追加照合は、未知の設定変化を誤ったrevisionに結び付けないための防御である。
5. callerがticketのawaitを取消してもworkerのMCP awaitへcancelを伝播させない。不要になったticketをmarkして受信を完了する。shutdown／明示resetではmanager.closeによって接続ごと破棄できる。

Phase 1Bは設定更新RPCそのものを省略・合成しない。callerは`await set_controls/merge_settings`→返されたrevisionで`request_preview`とする。通常変更の受付は実行中1＋待機1までに制限し、超過はsafe busyを返す。部分patch A／Bを単に最新Bだけへ置換してAの変更を失う実装は禁止。Preview ticketの最新集約と設定更新の意味を混同しない。

将来UIは入力イベントのdebounce／累積desired controls、ドラッグの確定単位、表示直前のtoken照合、Object URLのrevokeを担当する。BackendはUIの有無に関係なく上記の直列化・容量・stale判定を行う。BackendのFuture解決後に切替が起きる競合までは解決済みbytesを取り消せないので、将来UIにも最後の識別子照合が必要。Phase 1Bには暫定の古い画像を表示する例外を作らない。

## 8. 障害・timeout・再起動・終了

提案する期限はimport 60秒、通常command 5秒、Preview 60秒（初回も同じ）、raw操作の受付待ち5秒。複数command操作にも共通deadlineを持たせ、各RPCに残時間を渡す。画像検査は10秒の論理期限、明示resetのready待ちは最大35秒とする。数値はPoC初期policyであり実測保証ではない。通常ping／GPU／起動・回収のPhase 1A期限は維持する。

- admission timeout：未送信ならSessionを壊さずbusy。送信済みtimeout／cancel、EOF、未知ID、過大frame、壊れた画像response：clientをabortしmanagerの既存cleanupへ。raw sessionはlostとなり、全ticketをsafe errorで解放する。自動再送・自動restartしない。
- tool `isError`／JSON-RPC error：通信エラーと区別する。importのfailed配列も別途検査する。Previewの通常tool errorは画像なしの失敗として返し、設定readbackが成立する限りMCP readyを維持する。
- set成功後のget失敗、reset成功後のmerge失敗等：rollbackを仮定せずdesynchronized。最後の確定snapshotと未確定要求を区別し、Previewを停止する。安全なgetで同期を回復するか、明示resetへ進む。失敗した要求を再送しない。
- `reset_session(restore_active=True)`：受付停止・epoch無効化→旧ticket解放→manager.restartで旧child回収→新generation ready待ち→activeだけ再import→file同一性確認→保存済み全snapshotをreset＋merge＋getで復元→新handleを返す。元Sessionの他photo IDは全て無効。非active snapshotも最大2枚のメモリ内に保持し、再open時に明示復元できる。process喪失時に失われる「最後の未確定編集」は復元対象にしない。
- managerの直接restartが発生した場合も、旧raw handleはlost。raw serviceが黙って新clientへ書き込まない。回収不能時はmanagerのsession所有と二重起動禁止をそのまま尊重する。
- closeは最初に受付停止・epoch無効化し、manager.closeで進行中MCPを解放してからraw worker／画像検査をjoinする。raw操作lockを待ってからmanagerを閉じる順序にすると、長いPreview待ちがshutdownを遅らせるため避ける。LocalHostはraw.close→manager.close（冪等）→共通Backend終了。caller cancelは所有cleanupの完了後に伝播する。

一時画像対策としてgenerationごとに専用の私有temp directoryをmanagerが作り、子processのTEMP／TMPのみへ渡す。通常応答後は当該processのrender用残骸を操作lock下で安全に除去し、timeout／kill後はprocess回収後に当該directoryを掃除する。パスのroot検証を行い、既存PoCやOS temp全体を探索・削除しない。回収失敗時はdirectoryも所有し続ける。Backend自体の強制終了で残るdirectoryは既知の未解決事項とし、自動で他世代のdirectoryを広く削除しない。

CPU固定PoCのため、managerに内部constructor引数として`gpu_backend="dx12"|"off"`のみを追加する案とする。既定DX12、環境allowlistは維持し、親の任意GPU overrideを再導入しない。別process／明示resetで適用し、実行中の環境変更で切替できるとしない。CPU／GPUで異なる編集schemaは作らない。RAW操作やrenderをHTTP APIとして公開せず、ログもsource_key／generation／revision／sequence／byte数／寸法／処理時間／固定error codeに限定する。path、設定本文、Base64、画像、任意stderr・upstream error textは保存しない。

## 9. 変更予定ファイル（今回は未変更）

| ファイル | 実装時の変更案 |
|---|---|
| 新規`backend/lightcraft_raw.py` | 上記RAW session、snapshot／handle／frame型、操作lock、Preview worker、画像検証と容量policy |
| `backend/lightcraft_mcp.py` | envelope取得interfaceとrequest別byte budget。現行call_tool返値・1 MiB既定・排出処理は維持 |
| `backend/lightcraft_runtime.py` | expected generation付き内部RAW呼出し、StreamReader ceiling、専用TEMP所有、内部CPU固定指定。既存起動／監視／回収を再利用 |
| `backend/windows_local.py` | raw sessionのWindows限定所有・終了接続。ready待ちやstartup importは追加しない |
| 新規`backend/tests/test_lightcraft_raw.py` | fake command／画像、状態・revision・集約・復元・終了テスト |
| `backend/tests/test_lightcraft_mcp.py`／`test_lightcraft_runtime.py`／`test_windows_local.py` | byte budget、temp、generation、既存cleanupとWindows lifespanの回帰追加 |
| 実装後の`docs/architecture.md`／`docs/development-notes.ja.md` | 実装仕様・結果・実機未確認範囲の追随 |

共通`backend/main.py`、JPEG renderer／thumbnail／Export runtime、Recipe／History／DB、Frontend、Tauri、Docker、依存一覧の変更は不要な構成とする。画像検証は既存Pillow、Base64はstdlibを使う。診断endpoint、UI、永続snapshot形式は追加しない。

将来WebView2へは、既存同一origin認証を使った期限付きopaque Preview ID→image responseとBlob URLが第一候補。data URLはBase64を再び保持し、外部file URLは公開範囲管理が必要。Phase 1Bでは`PreviewFrame.bytes`を内部callerへ返すだけとし、HTTP endpointは不要。

## 10. 実装後のテスト・実機PoC・完了条件

### 自動テスト計画（未実行）

1. fake MCPで1枚import、get、select、control変更、merge、readbackを確認。importの部分失敗、duplicates.existing、same-path再open、別keyの同内容、null設定、preview-only、変更されたfileを扱う。
2. set/merge成功後にgetの補正値を返すfakeを使い、Exposure 5.0、geometry.scale 50.0、crop／curve、process V1/V2、WB scale有無、未知field／不正型を検証する。送信値を返すだけのmockにしない。
3. reset＋全snapshot merge＋getの順序、欠落optional fieldのreset、途中失敗とdesynchronized、readback不一致を確認する。設定getとcaller dict mutationの分離も確認する。
4. renderをgateで止めA実行中にB→C ticketを投入し、Bは未送信Superseded、Aは破棄、Cだけを返す。RPC render最大1、待機ticket最大1、画像検査中も次renderを開始しないことを計測する。
5. 同写真revision更新、A→B→A切替、新generationで同じphoto ID、待機lock中の切替、Future返却直前の新要求を試し、token／epoch／revision／sequenceの各guardを検証する。
6. partial receive、通知割込み、通常RPCの1 MiB超拒否、Previewの1 MiB超〜8 MiB受理、8 MiB超の実asyncio subprocess出力を試す。違反後排出とkill後wait完了を既存回帰へ結び付ける。
7. image contentなし／複数、偽MIME、不正Base64、5 MiB超、metadata超過、寸法不一致、PNG破損／truncation／巨大header／複数frameを拒否する。エラー本文・画像・pathをloggerへ入れない。
8. Preview中EOF／timeout／child kill、request待機cancel、owner／watcher同時cancel、close／restart競合、検査worker中closeを試す。全ticket、MCP pending、worker、processが解放され、回収不能時は再起動しないことを確認する。
9. 私有TEMP内の通常／失敗／kill残骸を回収し、外側のsentinelを残す。回収前削除禁止、世代directory分離、失敗時の保持、raw envelope／Base64のadapter参照が残らないことを確認する。count上限256変更／2枚の境界も試す。
10. 既存Phase 1AのMCP／runtime／Windows LocalHostとmanaged shutdown関連を再実行する。117件は過去の基準であり追加後の成功件数ではない。共通Backend、未設定／起動失敗、check-runtime、Export終了待機の境界を維持する。実行時はrepo `.venv`のPython 3.14、cwdは`backend`を使用する。

### 実機PoC計画（今回は未実行）

使用予定素材は`I:\code\raw-test\pixel\sample2.dng`、`I:\code\raw-test\pentax\sample.DNG`。Phase 1Aと同じ固定commitのCLIとSHA-256を記録し、検証出力は既存PoCとは別directoryに置く。原本／sidecarは変更しない。

- Windows開発Backendの内部Python interfaceから2素材を登録し、RAW kind／preview-only／寸法、設定process／WB、初回Previewと同設定の継続Previewを確認する。
- 露光`+0.25,+0.5,+1.0,-0.5,0 EV`を適用し、各get確定値とPreview寸法・破損なしを確認。初回／継続の時間、encoded bytes／wire bytes、peak working set／PrivateUsage、library.memoryを分けて記録する。
- gate付きテストとは別に実CLIへ連続Previewを要求し、集約・最後のrevision、写真A→B→Aの取り違えなしを確認。元のPoCの約56〜77 msを統合後の保証値にしない。
- DX12と別processのCPU固定offで同じ編集仕様が成立することを確認する。GPU availabilityだけでGPU実使用と断定しない。安全に再現できる場合だけ実fallbackを確認し、CPU固定成功を「GPU障害からのfallback成功」と言い換えない。実障害fallbackが再現できなければ未検証として残す。
- 明示reset後のactive再import・全設定復元・新generationを確認。途中終了、正常終了、temp／child／task回収、既存Backend継続を確認する。異常終了対象は今回の検証用childに限る。

完了条件は、focused自動テストとPhase 1A回帰が成功し、2素材で登録→設定変更→確定値→反復Preview→切替→明示復元→終了が内部interfaceから成立すること。制限内の有効なPNGを受理し、過大・不正画像は拒否して回収できること。古い結果が返却されず、待機Preview数が増えず、終了後に対象child／task／管理tempを残さないこと。`git diff --check`成功、実機の時間・メモリ・未検証fallbackを区別して記録すること。旧版との厳密な画素一致、UI、最終Exportを合格条件に含めない。

## 11. 未確認事項・判断事項・Phase 1Cへの引継ぎ

今回のソース調査では、**Phase 1Aを大幅に置換せずPhase 1Bへ進める構成は確認できた**。必要なのは有限の画像応答budget、envelope取得、RAW専用操作層、私有temp所有という限定拡張である。実装開始は別途指示を受ける。本書の上限・期限・2枚／256変更policyは設計上の推奨初期値で、実測で成立を確認していない。

未確認なのは、GenzoRoom経由のRAW decode／設定readback／Preview、8 MiB budget内への収まり、画像検査時のPython peak memory、長時間のnative memory、再起動をまたぐ全snapshot復元、decode後WB変更の実際の発生条件、私有TEMP設定と残骸cleanup、実GPU障害fallbackである。画像sizeを1024に制限しても原本decodeやdriverのhard memory／停止期限を保証しない。原本の同時書換えとTOCTOUも完全には防げない。

Phase 1Aから残るTauri経由の画面起動・通常終了、JPEG暗室実操作、PyInstaller DLL検索・外部CLI起動、Job Objectによる孫process回収は引き続き未検証。これらの成功を本設計書で追加認定しない。

Phase 1Cへの判断事項：

- 3枚以上の写真を巡回する際のeviction／snapshot復元、長時間の編集上限緩和、Session＋StageCache Rust Adapterとの比較。大幅なtransport変更やLightCraft本体改修が必要なら独断で採用せず再判断する。
- 永続Recipe／History形式、process／engine commitの保存責任、Undo単位、WB scale変換、再起動後の復元元。今回はDB・保存formatを決定しない。
- UIのdesired controls集約、interaction単位、WebView2画像配信・色管理・Object URL寿命。Backend ticket guardの上に表示直前guardを加える。
- RAW最終Export、Previewとの設定snapshot共有、停止／ファイル書込み、Immich登録・Stackとの整合。既存JPEG暗室／Export管理の変更は別設計とする。
- 高解像度Preview、JPEG品質選択、CPU／GPU差の評価。異なる編集schemaが必要という結論になった場合も別途判断し、画像差だけで仕様を分岐させない。
