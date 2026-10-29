# RAW Export Phase 0 — 実装前調査

調査日：2026-10-29。対象：`feature/lightcraft-integration` のローカル作業ツリー。
本書は設計案であり、製品実装・実RAW PoC・Immich書き込みの完了記録ではない。

## 1. 既存JPEG Exportの確定仕様一覧

LightCraft調査に先立ち、必読文書から以下を基準として作成し、JPEGコードで照合した。
根拠の優先順位は architecture の現行契約と後続完了節 → 現行コード → dated Phase記録。
READMEは利用者向け公開範囲、開発ノートは変更理由・過去の検証記録として扱う。

| 項目 | 確定仕様 | 文書・現行コードの根拠 |
|---|---|---|
| 写真管理 | Immichが写真の正本。元画像を変更せず別JPEGを登録 | README日英「Security / セキュリティ」「Export Management / 出力管理」、`backend/immich_export.py` |
| JPEG現像 | Recipe v18、16値と23 enable flags。無効中の値も保存。sRGB8の既存stage順・丸めを維持 | architecture「JPEG editing foundation」「Backend JPEG engine foundation」、`jpeg_renderer.py`、`edit_state.py` |
| 編集保存 | Recipe・History・cursorを検証してSQLite保存。Autosaveと操作境界Historyは別。HistoryだけではExport適格にならない | architecture同節と「Edit-status lookup」、`edit_store.py` |
| 成果物 | 正規化した原寸、JPEG品質95、4:4:4、sRGB ICC。MPOはframe 0のみ | architecture Phase 5A/B、`jpeg_codec.py:encode_jpeg`、`export_artifact.py` |
| メタデータ | EXIF/XMPの許可リスト再構成。Orientation=1、出力寸法、ColorSpace=1、Software/CreatorTool=GenzoRoom。元ICC・MakerNote・private tags等をコピーしない | architecture Phase 5B、`jpeg_metadata.py:prepare_metadata` |
| 命名 | first-dot family、末尾のcase-sensitive Genzo連番最大+1、欠番再利用なし、最低2桁の `-GenzoNN.jpg` | architecture Phase 5B/E、`export_artifact.py:next_export_filename`、`ImmichFamilyFilenameProvider` |
| Queue | Asset単位、挿入順、最大100件の一括操作。追加は保存済みcurrent non-default Recipe。queued/failedだけ解除可能 | architecture Phase 1とCurrent Gallery Queue safeguards、`edit_store.py:enqueue_export_assets` |
| Start | armed queued対象を再検証し、1 writer transactionで全対象の保存revision・Recipe・processing版・順序を固定してwaiting化。追加編集は実行中snapshotを変えない | architecture Phase 5C/E、`export_runtime_store.py:create_export_run` |
| Runtime | 同一Backendの単一serial worker。waiting→encoding→registering→成功時Queue除去。通常item failureはfailedとして後続継続、DB/ownership異常は復旧可能状態を保持して停止 | architecture Phase 5C–E、`export_runtime.py` |
| Stop | 永続Stop intent。current itemを完了後、後続waitingをqueuedへ戻す。実行中の現像を強制キャンセルしない | architecture Phase 5D、storeの`request_export_stop` / `begin_export_item` |
| Retry | failedを原子的にqueuedへ戻し、新run Startでその時点の保存Recipeを固定。単なる旧snapshot再実行ではない。UIはfailed群優先 | architecture「Current Export management」、`retry_export_assets`、`useExportManagement.ts` |
| 再起動 | frozen Recipeとitem timestampから生成し直し、登録を最初から再実行。worker UUIDを更新、旧workerの遷移を拒否。分散leaseではない | architecture Phase 5D/E、`reclaim_export_run` |
| 重複回復 | 同一source/toolchain前提でJPEG bytesを再生成。registration_failedのRetryは同一Queue/revision/Recipe/versionsの場合だけtimestampを再利用。ICC headerも決定的 | architecture Phase 5E、`test_export_retry_identity.py`、`jpeg_codec.py:_srgb_profile` |
| Immich | 新Asset upload、GenzoRoom tag、source Favorite ON/OFF継承。sourceがStack非所属なら作成、所属なら全member保持し生成物をCOVER化 | architecture Phase 5E、`immich_export.py:register` |
| Album | sourceと現Stack全memberの現在Album unionを出力へ付与。Stack/COVER検証後だけ最終non-COVERのAlbum所属を除去。cleanup失敗はwarnで成功維持 | architecture Phase 5E、開発ノート2026-10-20、`test_immich_export_albums.py` |
| 障害 | 部分remote成功を削除rollbackしない。未確認のStackへ書かない。取得・family・encode・registration失敗を固定codeで区別。秘密・画像・Recipe本文はログ対象外 | architecture Phase 5E、`export_runtime.py`、`immich_export.py` |

実機で見つかった修正理由も継承する：Favorite欠落でCOVER化後のFavorites表示が変わる、child sourceを無関係Stackまで巻き込まない、Albumでは非COVER由来Exportも旧COVERの所属を継承し、新COVERへ正規化する。Retryではcanonical Queue refresh失敗／Start応答喪失を成功とみなさない。開発ノート「Phase 5F」「Phase 5 Export横断監査」「Album内StackのExport正規化」、CHANGELOG v0.1.0以降の修正記録が根拠。これらの過去の実機成功を今回再検証したとは扱わない。

## 2. RAWへ再利用可能な機能一覧

| 機能 | 再利用範囲と必要な境界変更 |
|---|---|
| Queueと管理画面 | 同じAsset Queue、Q/W、armed/selection、polling、Start/Stop/Retry。RAW適格判定とGallery/FilmstripのRAW除外を拡張。JPEG診断候補filterは維持 |
| 永続Runtime | 同じrun/item、transaction、serial順序、ownership、Stop/reclaim。snapshotの型とvalidatorにRAW variantが必要 |
| 原本取得・family検索 | Immich detail/original、完全family検索と既存命名を利用。RAW描画入力のhash照合を追加 |
| Encoder | `RenderedImage`のfull-size sRGB RGB8に接続できれば、既存品質95/4:4:4/ICC encoderをそのまま利用可能 |
| メタデータ | allowlist・validator・再構成・上限・決定的timestampを再利用。JPEGを開く取得部だけRAW metadata adapterへ分離が必要 |
| 登録 | `ExportArtifact(filename,jpeg)`とsource detailを渡す既存registrar。Album/Stack/COVER/Favorite/tag意味は変えない |
| 障害と診断 | item failure、Retry/recovery、safe code/ID中心のstructured logs。RAW engine identity・generation・restore失敗境界を追加 |

`create_export_artifact()`は原本を`decode_jpeg()`するためRAW bytesを直接渡せない。`JpegRenderer`へRAW settingsを変換する案も採らない。共通化は生成画素／検証済みmetadataから先の境界で行う。

## 3. 調査対象と証拠の範囲

- managed source：`.tmp/lightcraft-0.14`、HEAD `03c88c166c054c009db2a47187d59991f6232b85`。manifestのv0.14.0と一致。
- 適用パッチ：`native/lightcraft/patches/0002-v0.14-native-contracts.patch`。SHA-256 `9308d0663de3e4d1f6fd65e564fb04cc7ac1c993b5c1a2aae29ef1f72b521063` を実ファイルで確認。managed sourceに対する `git apply --reverse --check` 成功。変更対象一覧もmanifestと一致する。適用・逆適用そのものは行っていない。
- 既存EXE：`target-wb-phase1/release/lightcraft-cli.exe` の実SHA-256 `b872315ccd11c5c2e945f473d8ca48022127a4cc196b95d16ff3d8fb75004251` が隣接 `.genzoroom.json` receiptと一致。receiptはBefore/Preview/Region/WB=1、geometry descriptor=2と現manifest tupleを保持。
- 今回はEXE起動・handshake/schema再検査・描画・再ビルドはしていない。上記は静的なsource/receipt/hash確認であり、新Export契約のbinary受入証明ではない。
- upstreamの最新一般仕様ではなく、この固定managed treeを対象にした。根拠は下記のファイルと関数で追跡する。`.tmp`は配布・永続参照先ではなく、再調査時はmanifestから同じsourceを用意する。

### 文書と現行コードの差分

1. architecture Phase 1～5D内の「Start未実装」「registrar未接続」と `export_runtime.py` のmodule docstring／Phase 5E待ちコメントは歴史的記述。`main.py:lifespan` は既にproduction source/family/registrarを接続し、`POST /export/runtime/start` とrecoveryを有効にする。architecture冒頭・Phase 5E・Current Export managementが現行仕様。
2. architectureのJPEG foundationには「Only JPEG assets are editable」「LightCraft is an unselected candidate」が残るが、現在のWindows RAW編集・永続Recipe/Historyは同文書冒頭のcurrent contractとRAW節、`windows_local.py` / `windows_raw_api.py`に実装済み。JPEG foundationの局所説明を製品全体の現在制限へ広げない。
3. README日英のJPEGのみ／RAW将来候補は公開JPEGワークフローの記述であり、ブランチ上のWindows RAW編集実装を網羅していない。RAW **Export** は実際に未接続。`ExportRuntime._process_item` がRAWを `source_not_jpeg` で拒否する。READMEは今回変更しない。
4. `INTEGRATION_DESIGN.md` はv0.9.1時点の提案。現在はmanaged MCP、StagePool、Full/Draft、Before/Region、RAW Recipe/Historyが存在し、過去の「StageCacheなし」「永続化未採用」を現状とはしない。ただしExport bytes応答がない点は現行にも残る。
5. architecture Phase 5Bの「XMP時刻は秒」より後のPhase 5Eが優先される。現行 `prepare_metadata` は非ゼロmicrosecondがあればmillisecondを保存し、Retryのbyte identityに使用する。

## 4. LightCraft v0.14.0の実際のExport契約

### 4.1 MCP要求・応答

根拠：managed `crates/mcp/src/tools.rs` のtool `export` / `call_tool`、`headless.rs:Headless::export`、`crates/engine/src/export.rs:ExportOptions` / `BatchWriter::place`。

```json
{"jsonrpc":"2.0","id":101,"method":"tools/call","params":{
  "name":"export","arguments":{
    "id":1,"path":"<owned isolated output>/result.jpg",
    "format":"jpeg","longEdge":0,"quality":95,
    "colorSpace":"srgb","bitDepth":8,"hdr":false,
    "sharpen":"none","metadata":"none","addToPhotos":false
  }
}}
```

これは説明用要求で、今回送信していない。`id` はそのSessionでimportしたNative PhotoIdでありImmich UUIDではない。`command_run` の `{id:"app.export",params:{...}}` も同じheadless実装に接続する。`ids`なら複数だがGenzoRoomは1 itemずつ明示IDで呼び、Nativeの選択状態／batch既定に依存しない。preset、limitKb、watermark、sameAsOriginalは使わない。

- `path` は単一出力の正確なパス。既存fileを置換するため、Backend所有の隔離directoryと新規名を使う。`dir`はbatch用で衝突方針unique/overwrite/skipを持つ。Native命名はGenzoRoom命名の代替にしない。
- 成功はMCP `content` のtextにJSON object。singleでは先頭fileの `path,width,height,bytes,sidecars` をtop levelにも置き、`files`配列を追加。`bytes`は長さであり画像bytesではない。CPU fallback時は `gpuFallback` が加わり得る。エラーはtool `isError`／JSON-RPC errorとして処理し、raw error文を利用者やログへ転送しない。
- path-lessでも画像contentは返らず、既定dirへの書き出しを試みる。`background:true`はheadlessを非同期化しない。headlessはblocking。
- 標準Exportには `stage_cache`、Preview契約、設定fingerprint echo、bytes返却、Export専用contract versionがない。既存パッチはこのExport APIをbytes方式へ変更していない。

### 4.2 完全なDevelopSettingsと固定

`get_develop {id}` がfull settingsを返す。`set_develop {id,settings:{...}}` は**deep merge**であり置換ではない。`develop.merge`も同じ。UIで見えるcontrol値だけを送ると、process、WB scale、mask、crop、orientation、optics、denoise等を失う。

現行GenzoRoomの安全な復元手順は `lightcraft_raw.py:_restore`：対象選択 → `develop.reset` → 完全settingsの `develop.merge` → `get_develop` readbackと正規化JSON一致確認。Exportにもこの意味を継承し、復元不一致は出力中止。Native PhotoId／active selection／generationの所有を一連操作全体で守る。個々のMCP要求がserialでも、複数要求間への別編集の割り込みは防げない。

現行RAW保存はschema 1、明示processと全settings、Asset ID、sourceContentHash、engine name/version/commitを保持する。version/commit差だけでは通常編集へのrestoreを拒否しないが、出力再実行のbyte identityにはより厳しい実行環境固定が必要（§6）。古いRecipeを復元して現在engineで保存する場合も古いrowは書き換えない。

### 4.3 原寸・品質・色

| 条件 | ソースで確定できること | 注意 |
|---|---|---|
| 原寸 | `longEdge:0` は有効。`has_size_param`がtrueとなりheadless既定3000を回避し、resizeなしになる | `render_preview max_side:0` は代替にならない。PreviewはclampとBackend上限2048を持つ |
| 寸法 | `output_size`→`native_output_size`、crop/orientation/geometryを反映した現像後native寸法 | センサー格納寸法と常に同じではない。実RAWで期待寸法を検証 |
| 品質95 | `quality:95` → JPEG codecへ95を渡す | 「95」はcodec依存。Pillowの95と同じbytes／量子化表とは限らない |
| 4:4:4 | `encode_with_metadata` は `limitKb`なしならS444、ありならS420 | 明示subsampling引数はない。preset/limitKb禁止で条件固定 |
| sRGB ICC | `colorSpace:"srgb"`、8-bit SDRへ描画し `icc::write_named(Srgb)` を埋込 | 最終既存encoderを使う場合はGenzoRoomの決定的ICCへ置換 |
| 追加処理 | `hdr:false`, `sharpen:"none"`、watermarkなしを固定 | settings内HDRが有効な場合のSDR表示差もPoC対象。形式設定UIは追加しない |

### 4.4 Previewとの一致条件と限界

根拠：`engine/src/media.rs:render_job` / `export_job` / `develop_reporting`、`mcp/src/headless.rs:adaptive_render`。

同じsource hash、同じ完全settings/process、同じengine/patch、Full品質、sRGB8、After、同じgeometryが前提。Exportは `export_job` を用い、reduced decoded sourceを避け、必要ならdenoised sourceを生成する。Draft preview、縮小source、表示用PNGやRegionの切り抜きをExportへ流用しない。NativeのFullも「元RAWの全解像度」と同義ではない。

縮小Previewとfull-size Exportはサンプリング、detail/denoise、処理解像度、JPEG量子化、WebView色表示の差を持つ。ピクセル完全一致を約束しない。比較は同じgeometryのfull出力を適切に縮小したものと、settled Full Whole previewで行い、露光/WB/トーン/クロップの体系的差とJPEG誤差を分ける。CPU/DX12はsourceコメント上1–3 LSB程度の差があり得るため、GPU一致・bit一致は実測なしに断言しない。

### 4.5 CPU/DX12・StageCache・予算

- Export jobは共通pipelineのGPU可否判定とCPU fallbackを使う。GenzoRoom PreviewのDX12 capability／実行診断を、そのままfull-size Export成功の証明にはしない。大きいtexture/buffer、geometry、denoise等で条件が変わる。
- 現行headless ExportはPreviewの `Headless.stages` をjobへ渡さない。`RenderJob`は通常 `stages:None`。Session source cacheの再利用とStageCache再利用は別物。StageCacheをExportへ追加する必要は初期仕様にはなく、まずoffでメモリを制限する。
- upstream `render_weight` の見積もりはsource約12 B/px＋出力約36 B/px。24 MPなら約1.15 GB相当であり、Backendバッファ、Preview常駐cache、Base64/JSON、codec、GPU staging、denoise model等は別に加わる。ソース内24 MP約1.2 GBのコメントは今回の実測ではない。
- `too_big_for_memory` は主にnative以上への拡大を抑止する条件であり、原寸Export全体を安全にadmitするメモリ上限ではない。GenzoRoomでpixel/encoded bytes/同時process/peak予算を別に設定する。
- 既存v0.9.1 Linux CPU測定（Pixel約1.04 GiB、Pentax約1.60 GiB）は過去環境の値。v0.14 Windows DX12、managed patch、今回のExport経路の速度・peak RSS/VRAMは未測定。
- 推奨初期方針：ExportはCPU固定で再実行の決定性を先に確立。DX12はPoCでfallbackを含むbytes再現性を評価してから採否を決める。CPU固定が遅すぎる場合も同一run recoveryでCPU/GPUを黙って切り替えず、既存JPEGの重複回復保証を弱めない。

### 4.6 転送・timeout・cancel・無変更保証

標準MCP Exportは一時画像fileを必要とする。ただしNative engine内部には `PreparedExport::run` → `Exported.bytes` というメモリ境界が既にあり、managed MCP拡張ならfilesystem writeを省略できる。画素をlossless PNG等にして返しBackendで一度だけJPEG化するか、Native JPEGを再圧縮せずAPP metadataだけ再構成する方式を比較する（§8）。既存 `render_preview` は小画像専用であり、上限を外すだけの転用は採らない。

現行 `backend/lightcraft_mcp.py`：通常応答1 MiB、Whole preview特例24 MiB、Region特例13 MiB。`lightcraft_raw.py`：画像17 MiB、settings256 KiB、Whole長辺2048。画像返却toolは名前でresponse limitを切り替えるため新tool追加時も更新が必要。RAW原寸PNGやRGBを既存特例に入れてはいけない。RGBは最低3×pixelCount、Base64で約4/3、JSONや複製も追加。新契約には有限pixel/encoded/decoded/line上限とheader検証が必要。大画像を見て無制限に上限を上げない。

現行manager timeoutはrequest5秒、gpu15秒、RAW adapterはimport/preview60秒・command5秒。Export専用timeoutは未実装。PoCでcold/warm full-size時間を測り有限上限を決める。送信後timeout/cancelはtransportをabortしgenerationを失効する。Native serverの `notifications/cancelled` は無操作で、同期decode/renderを途中停止しない。Stopはこの機構を使わず、現行どおりcurrent item完了を待つ。強制終了はtimeout/異常終了専用とし、出力未確認時は登録しない。process再生成後はimportとfrozen settings restoreからやり直す。

JPEG Export自体はNative DevelopSettingsを編集せず、新しい `RenderJob`にsnapshotを持たせる。`OriginalGuard`は原本・sidecarへの出力を拒否する。一方、復元のreset/mergeはNative Session内settings/Undoを変更する。**編集用live sessionをそのまま書き換える案は不採用**。隔離したExport Sessionで実行し、GenzoRoom Recipe/Historyのsave APIを呼ばない。

LightCraftにはXMP auto-writeもある（`engine/src/lib.rs:execute`、`sidecar.rs:XmpPrefs`）。原本保護をpath guardだけに任せず、Export専用Sessionをin-memory・auto-write off・永続libraryなし・Backend所有の原本copyだけで動かす。原本hashとRecipe/History行が前後で不変、予期しないsidecarが作られないことは正式実装のテスト／PoCで確認する。Native一般機能全体が無書込とは言わない。

## 5. EXIF/XMP継承方針

### 5.1 原則と取得経路

`jpeg_metadata.py`は画素decodeと独立したallowlist再構成だが、入口が `Image.open(JPEG bytes)` に結合している。RAW metadataをPillowで開けると仮定せず、raw container抽出 → typed allowlist値 → **共通validatorとserializer**へ接続する。既存JPEG入口は互換性を維持する。LightCraft JPEGのEXIF/XMPを正本にせず、必要情報は原RAWから得る。

managed `crates/meta/src/container.rs` はTIFF/DNG等、CR3、MRW、RAF等のcontainer抽出を持つ。`lightcraft_meta::Metadata`は共通型へ正規化するため、全標準tag／元表現を保持しない。`export_metadata()` はさらにcatalogのsubsetへ落とす。既存 `photo.inspect` 等の表示metadataも完全EXIF取得APIではない。

初期のPixel DNGとPentax TIFF系RAWでは、Nativeの既存container/TIFF readerを利用し**GenzoRoom allowlistに必要な標準tagだけ**を型付きで返すmanaged契約を推奨する。元TIFF blockはRAW全体を含み得るためBackendへ丸ごと返さない。MakerNoteの再配置／無条件コピーやvendor serialの保持はしない。別のBackend parserを追加する場合は対応形式、依存配布、malformed container制限をPoCで比較してから選ぶ。LightCraft共通Metadata型を使うだけでは下表の差を閉じられない。

| 情報 | JPEGの現行管理 | LightCraft経路で分かること／RAW差分 |
|---|---|---|
| 撮影日時 | DateTimeOriginalを検証して保持 | meta readerは日時を取得可能。catalog→Exportではcapture ISO経由。原tagから取得を優先 |
| timezone・subsecond | OffsetTimeOriginalと任意桁数字SubsecTimeOriginal | Native DateTimeはoffsetを持つがmillisのみ（3桁へ切詰め）。標準tagの文字列を直接許可リストへ渡す必要 |
| メーカー・機種 | Make/Model | Native meta型は両方あるが `export_metadata` はModelだけを設定。Native JPEGからMake復旧は不可 |
| レンズ | LensMake/Model/Specification | meta readerに対応値はあるが標準Exportは主にLensModel。原RAWに標準tagがあるか実fixtureで確認 |
| 露出 | ISO/ExposureTime/FNumber/FocalLength、35mm換算、bias/program/metering/flash/WB等 | 標準ExportはISO/shutter/FNumber/focal中心。float表示値から元rationalを作り直すより原tagを検証して継承 |
| GPS座標・高度 | 座標/ref、高度/ref、GPS日時と撮影方向/refを個別検証 | meta型Gpsは緯度経度高度のみ。`export_metadata`で高度Noneとなる。GPS日時・撮影方向は共通型にないためraw tag抽出が必要 |
| 著作権・作者・説明 | ASCII EXIF、UnicodeはDC XMP | meta型／Native Exportにも一部あるがlanguage alternativesや複数creator等の表現を完全保持する契約ではない |
| タイトル等XMP | DC title/description/rights Alt、creator Seq、subject Bag、XMP Rating/Label | 原RAW内標準XMP packetから既存bounded parserを再利用。LightCraft設定namespaceや任意構造は移送しない |
| Orientation・寸法 | Orientation=1、rendered寸法へ再構成 | Native Exportもupright。原RAWの向き・格納寸法を最終JPEGへコピーしない。二重回転を防ぐ |
| 色 | ColorSpace=1、新sRGB ICC | RAW camera profile/元ICCはコピーしない。現像がsRGBになった事実とICCを照合 |
| Software・更新日時 | GenzoRoom、永続item timestamp | Native標準ExportはSoftware=LightCraft。必ず共通serializerでGenzoRoomへ再構成 |

LightCraft `Metadata`にはcamera/lens serialもあるが、GenzoRoom許可リストでは除外。標準metadataを得る内部decoderがMakerNoteを解釈できることと、MakerNoteを成果物へコピーすることは別。初期契約では公開標準tagだけを扱い、vendor由来補完は対応・根拠を明示する後続候補とする。

### 5.2 必須・欠落許容・競合

- **出力必須**：検証済みJPEG、現像後寸法、upright、sRGB8/ICC、品質95/4:4:4の生成条件、Software/CreatorTool、妥当な永続export timestamp、入力source hashとsnapshot ownership。ここが不明／不一致なら登録しない。
- **取得できれば保持する重要情報**：撮影日時・offset/subsecond、カメラ／レンズ／露出、GPS、著作権・作者・説明・タイトル。元にない値は欠落を許容し、推測で作らない。標準tagが存在するのにadapterが捨てる差は「元にない」と扱わずPoC不合格。GPS方向等を非対応のままリリースするなら仕様差を明記して判断が必要。
- **malformed optional field/container**：既存JPEG同様、正常な画素処理が成立するなら個別drop／再生成を許容しwarnのsafe reason/countを記録。文字値や座標はログしない。parserが不正containerを単なる空metadataへ落とす場合はmissingとinvalidを区別できる契約へ補強する。
- **除外**：MakerNote、serials、vendor/private tags、embedded preview/thumbnail、元Software/ICC/構造、Recipe/History、LightCraft `lc:*`/CRS編集packet、Motion Photo/gain map等。APP13/IIMやextended XMPを新たに継承対象へ広げない。
- Source標準EXIFと埋込標準XMPを既存JPEGと同じ役割で扱う。Immichのdetail metadataはfileCreatedAt/Favorite等の現行登録用途に使い、欠落した原EXIFを無検証に補完しない。外部sidecarを取得して合流する機能は今回追加しない。Immich metadata editsと原RAWの差がある場合も既存JPEGの原本基準を勝手に変えない。
- timezone不明ならOffsetTimeOriginalを付けない。fileCreatedAtを撮影時刻と偽装しない。uploadのfileCreatedAtは従来どおりImmich detailのdateを利用する。
- 16 KiB text、128配列要素、XML深さ12/1024要素、APP1上限、DTD拒否、Unicode/ASCIIの扱いは既存と共通。RAW全体／TIFFのoffset探索には別途入力サイズ・IFD数・循環・型／長さの上限も必要。

## 6. 既存基盤へ接続する最小変更範囲

### 6.1 snapshotと永続状態

共通Queue/Runtimeを維持し、run itemにversion付きのdiscriminated snapshot（JPEG/RAW）を導入する。既存JPEG行の意味をそのまま読める形で必要最小限のschema追加を計画し、既存 `frozen_recipe_json` に判別なしでRAW objectを詰めない。現 `export_runtime_store._read_run` はJPEG `_recipe`、v18、JPEG processingVersionを必須とするためrenderer分岐だけでは足りない。今回はmigrationの作成・実行を行わない。

| 状態 | 所有者・固定時点・不変条件（正式実装案） |
|---|---|
| Queue intent | 既存Queue store。enqueueは保存済みRAW currentとverified import-default比較で判定。History lengthを判定に使わない |
| RAW snapshot | Startの同一writer transaction。kind、Asset ID、source hash、保存Recipeの全identity/settings、recipe revision、settings schema/process、出力契約versionを固定 |
| 実行engine | Start前にready attestationを確認し、version/commit/patch digest/contracts/binary hashとCPU policyをsnapshotへ固定。取得元Recipeのengine tupleとは区別 |
| item timestamp | 既存store。再起動は同値、同一registration failure Retryも完全identity一致時だけ同値 |
| Native PhotoId/generation | 1回のExport実行のみ。DBへ保存しない。再起動時は原RAW再取得・hash照合・再import・全settings復元 |
| 出力bytes | itemローカルのみ。DB/cacheへ永続しない。検証済みartifactだけregistrarへ渡す |

enqueue→Startの間に編集した場合はStart時の最新保存revisionを採用する。enqueueでRecipeを固定しない。暗室QはRAW gestureをdrainして既存 `prepareSave` に相当する保存確認を完了し、成功後にenqueue。Home/Exportは未保存live stateを直接読まない。

Start後の追加編集・Undo/Redo・default resetはrun itemを変更しない。RAW通常save/resetによるQueue cleanupもJPEGと同じくqueued/failedだけを同じDB transactionで解除し、activeは残す。現 `raw_recipe_store.py` はこのQueue cleanupを持たないので追加が必要。ResetがRecipeを削除してもactive frozen settingsで完了できるよう、処理をlive編集sessionやcurrent DB行へ依存させない。

RAW rowはidentity別に複数存在し得る。`get_raw_edit_statuses` はupdated_at降順→recipe_revision降順で最新rowを選び、`importDefaultsFingerprint`、旧行ではHistory baselineを比較、判定不能はNone。Export用selection/eligibilityを同一writer transactionで共用するhelperが必要。完全同時刻・同revisionの異なるidentityのtieは現照会に最終tie-breakがないため、Exportでは曖昧な候補をfail closedとし、通常表示と不一致を生まない共通化を実装時に決める。最初に見つかったrowを推測で採用しない。

Retryでは新runのcurrent保存Recipeを採用する既存仕様を維持。registration_failed時のtimestamp再利用条件にはRAW kind/source/settings/revisionに加え実行engine/patch/binary、render policy、metadata/encoding contractも含める。別engineで同じtimestampを使って異なるbytesになるのを防ぐ。

再起動時に固定engineが利用不能なら、古いengineを自動download／fallbackしない。RAW itemは登録前の固定safe failureとして残して後続JPEGを進められる設計を推奨する（DB破損は従来どおりworker停止）。手動Retryは現在engineを使う新attemptになり、部分出力重複の可能性を隠さない。JPEG recoveryは従来のsource/toolchain同一前提を維持する。CPUでもNative code／codec更新後のbyte一致は保証しない。

### 6.2 Backend接続箇所

| ファイル／境界 | 必要な差分 |
|---|---|
| `edit_store.py:enqueue_export_assets` | 現在はJPEG `asset_edit_states`のみ。RAW row/適格判定も同一transactionで扱う。APIのAsset ID配列契約は維持 |
| `raw_recipe_store.py` | 最新保存選択・baseline適格判定の共通化、default save/reset時のmutable Queue cleanup。Recipe/History本文・形式は変更しない |
| `export_runtime_store.py` | JPEG専用validator、frozen columns/serialization、create/retry/read/reclaimのRAW variant。旧JPEG run/Queueとfailure code互換 |
| `export_runtime.py` | detail.format/is_rawのJPEG専用拒否からsnapshotに従う適格source検証へ。JPEG `_artifact`を保持し、RAW描画adapterを追加。serial worker/Stop/registrarは共有 |
| `export_artifact.py` / `jpeg_metadata.py` | RAWへJPEG decodeを強制しない入力境界。共通命名・metadata serializer・encoderを利用。JPEG source検証は弱めない |
| LightCraft manager/adapter | Export能力/schema/receipt確認、専用job lifetime、全settings復元、原寸出力、有限応答／timeout、generationとsource identity照合、cleanup |
| `main.py` / `windows_local.py` | renderer依存注入とrecovery順序の調整。現common lifespanが先にruntime.recoverし、その内側でLocalHostがmanagerを作るため、そのままではRAW recoveryが間に合わない |
| `immich_export.py` | `ExportArtifact`とsource AssetDetailを既存registerへ渡せる。現registrarにJPEG source限定の拒否はない。Album/Stack/Favorite/tagアルゴリズムは変更不要 |

Windows localでRAW providerの準備後に共通Runtimeのrecoveryへ進むか、同じRuntimeへbounded readiness待ちproviderを先に注入する。startup/recoveryとshutdownでExport childが先に失われない順序を設計する。manager準備待ちでJPEG readinessやDocker起動を止めない。

### 6.3 Frontend・混在Queue・Docker

- `GalleryPage.tsx:queueStateFor` はRAW standaloneを空集合、Stack memberを `!is_raw` に限定。ここを共通eligible member判定へ拡張し、RAW補正済み判定がtrueでもQueue操作はまだ無効という現在の差を閉じる。Stackはany-member ON／partial専用表示なし／最大100件分割／locked member guardを維持。削除時はengine unavailableでもqueued/failed RAWを解除可能にする。
- `Filmstrip.tsx` の `onQueueToggle && !asset.is_raw`、`AnshitsuPage.tsx:toggleQueue` のJPEG local state/save経路をRAW coordinatorへ接続。現在のRAW非interactive EditedBadge表示、補正判定、History-onlyの意味を壊さず、保存未確認／default／unknownでは追加させない。
- `useExportQueueAssets.ts` と `ExportManagement.tsx` は既にformat/is_rawを表示でき、全RAWを除外する処理はない。既存page、format filter、Stack表示、armed／Retry優先を継続。RAWも既存status色に従う。描画中の文言がRAW現像を含むことを確認する。
- `exportQueueCandidates.ts` はJPEG Export **診断用**候補選定（最大10）の制限であり、管理画面全体の制限ではない。JPEG診断はJPEGのまま維持し、RAW追加のために無差別にこのfilterを外さない。
- Queue対象のRAW thumbnailは初期にはImmich thumbnailで識別可能。JPEG用Recipe-rendered thumbnailへRAW settingsを渡さない。RAW現像済みthumbnail永続cacheは今回の最小実装に含めない。見た目の限界を明示し、別管理pageを作らない。
- WindowsだけRAW rendererを注入。Dockerは既存Pillow/NumPy JPEG経路のまま、LightCraft binary/CUDA/DX12／新portを要求しない。共通validatorのRAW row読取対応は必要でも、Dockerで新規RAW追加・Startを誤って許可しない。既存RAW intentを読んだ場合の解除／safe refusalを用意し、JPEGだけのrunは通す。NASへRAW computeを移す案は採らない。

## 7. 検証計画

### 7.1 実装前の最小PoC（Immich無書込）

これは実行案であり、今回は未実施。新build環境を作らず既存attested EXEを使う。利用者の指定したPixel DNGとPentax RAWの**copy**を小さな隔離tempへ置き、原本／copyと保存Recipe/Historyを読み取り対象として扱う。settings JSONはtemp copyだけを作る。永続LightCraft libraryなし、XMP auto-write off、network登録なし。共有DBへのsave/migrationを起動しない。

1. source hashと既存保存identity・全settingsを取得。各RAWにつきdefaultと、保存済みの目立つWB/露光/色・geometryを含む代表設定を選ぶ。対応UIにない設定を推測で作らない。
2. 隔離MCP Sessionでimport→select→reset→merge全settings→get/readback一致。前後settings/source hash/sidecar有無を確認。
3. §4.1の明示要求でJPEGを隔離出力。full-sizeをcrop/orientation込みのNative計画と実JPEG SOF寸法で照合。品質95は呼出条件とcodec経路で確認し、SOF sampling factorが全component 1×1（4:4:4）、ICCが読めるsRGBであることを独立parserで検査。「JPEGの品質値95」という標準tagがあるとは扱わない。
4. Native raw metadata→catalog→Native JPEGの差をtag単位で採取し、表§5の欠落を実fixtureで確定。特にPixelのoffset/subsecond/GPS方向、Pentax camera/lens/露出。値や原本pathsを通常ログへ書かず、PoC成果は限定公開の検証資料として管理。
5. Native PNG Export（longEdge0/sRGB8/HDR off/metadata none/sharpen none）も隔離出力し、Backendでlossless decode→`RenderedImage`→既存encoderを呼ぶstandalone試行を計画する。Native JPEGのdecode→JPEG再encodeはしない。metadata adapter未実装時は「metadata同等性未達」と分離して測る。
6. settled Full After Previewと原寸結果の縮小を並べる。default/代表編集、保存→新Session復元の結果を比較。Before/RegionやDraftを基準画像へ混ぜない。目視は利用者のWindows実機確認とし、自動pixel差と区別。
7. 同一source/settings/export timestamp/CPUで冷起動2回とwarm2回の出力checksumを比較。途中failure後再生成も比較。CPU/DX12の速度、peak RSS/VRAM、source+PNG+Backend encodeの合計時間・peakを分けて測る。DX12のfallbackと再実行checksumも調べ、固定policyを決める。
8. malformed settings／復元不一致、出力dir不可／disk full相当、timeout／process終了時に成果物が登録扱いにならないこと、原本hashと保存Recipe/Historyが不変なことを確認。PoCはImmich upload/tag/Album/Stackの呼出を一切持たない。

最小PoCの合格条件：両fixtureで原寸と固定JPEG条件を満たす、保存復元後の代表設定が反映、標準metadataの取得可否一覧が埋まる、同一CPU/toolchainで再生成が決定的、メモリ・時間が有限予算へ収まること。Native patch経由の無file転送は既存EXEでは検証できず、次の限定契約PoCへ分ける。未達を新QueueやJPEG仕様変更で回避しない。

### 7.2 正式実装後の自動テスト

既存テストを基礎に差分を追加する。以下はテストの読取による対応表であり、今回実行した結果ではない。

| 既存coverage | 追加する回帰／統合境界 |
|---|---|
| `test_export_artifact.py` / JPEG codec/renderer tests | JPEG bytes・metadata互換維持、RAW allowlist、malformed/overflow/DTD、二重回転／二重JPEGなし |
| `test_raw_recipe_store.py` / `test_raw_history_store.py` | verified default／non-default／unknown、旧baseline、複数identity、Undoでdefault、save/resetとQueue cleanupのatomicity |
| `test_export_queue.py` / `test_export_runtime.py` | RAW/JPEG混在、100件atomic freeze、保存競合、Start後編集、kind/source mismatch、serial順とbuffer解放 |
| `test_export_recovery.py` / `test_export_retry_identity.py` | current RAWでStop、未開始release、generation喪失、再import/restore、engine mismatch、timestamp再利用条件、JPEG後続継続 |
| `test_lightcraft_mcp.py` / runtime/raw/patch tests | 新契約schema・実応答、上限、timeout/cancel、invalid pixels/dimensions/hash、process reap、原本/sidecar不変、live編集を変更しない |
| `test_immich_export.py` / `test_immich_export_albums.py` | RAW sourceと生成JPEGでFavorite ON/OFF、tag、non-COVER source、Album union→新COVER→cleanup、partial retry duplicate収束をfake transportで確認 |
| Frontend Queue/管理/RAW保存 tests | Q保存drain、unknown拒否、RAW/JPEG Stack任意member、format filter、locked/failed解除、Retry優先、uncertain Start/canonical refresh、engine unavailableでも解除可能 |
| Windows lifecycle tests | readiness前recovery、shutdown drain、timeout child cleanup、JPEG readiness非依存、Docker RAW providerなしでJPEG動作 |

Frontend/Backend両側の関連tests、TypeScript、production build、diff checkが必要。広範なstore/snapshot変更なのでmigration rollback、旧JPEG run回復、混在failure境界の検証は必須。全suiteを実施するかは実際の変更範囲とfocused coverageの不足を説明して判断する。routineのfull Docker smokeは行わない。

### 7.3 正式実装後の利用者実機確認

WindowsのPixel/Pentax実RAWでPreviewとの見た目、原寸・保存復元・Stop待ち時間・メモリを確認。Immich書込はこの正式検証段階で別途行う。RAW/JPEG混在Queue、単独RAW、RAWが非COVERのStack、Albumなし／複数Album、Favorite ON/OFF、partial Album failure Retry、再起動を確認する。

AlbumはImmichの**生membership**とnative UI、新COVERと旧member、GenzoRoom Galleryを併せて検証する。Gallery枚数だけで合格にしない。原RAWと既存Recipe/History不変、生成JPEGのSoftware/ICC/tag、既存JPEG ExportのNAS回帰も利用者確認項目。今回ブラウザ起動・NAS確認・Immich書込は実施していない。

## 8. 採用推奨案・代替案

| 案 | 利点 | 制約／判断 |
|---|---|---|
| A. 既存MCPでlossless原寸PNG temp→Backend既存JPEG encoder | Native変更なしで画素・色・時間のPoC可能。既存Encoder/metadata責任を維持 | 一時出力I/O、PNG容量、cleanupが必要。metadata取得不足は別に解消が必要。**実装前PoCに推奨** |
| B. 既存CLI `render` | 1回のprocessに隔離、`--settings`と `--size 0 --quality 95 --opt colorSpace=srgb --opt hdr=false --opt sharpen=none --opt metadata=none` 等で既存engine利用 | 入力/設定/出力fileが必要、毎回import/decode、readback契約が弱い。`--settings`もmerge。stdout bytes返却はない。再圧縮回避にはPNG出力。MCPより有利かは実測。fallback候補 |
| C. managed MCPへExport専用lossless bytes契約 | 原寸sRGB画素をBackendで既存JPEG化。temp成果物なし。identity echo/limits/metadataを契約化できる | Native/transport/receipt拡張、Base64とPNGのメモリ。**正式実装の第一推奨**、限定PoCで予算を満たすことが条件 |
| D. Native JPEG bytes＋JPEG marker単位のmetadata置換 | JPEG一度だけ、transferが小さい。Native標準95/S444/sRGBを利用 | 既存Encoderを通らずJPEG marker安全再構成が新規責務。entropyを変えずICC/EXIF/XMPを置換する実装・bounds・決定性の検証負担。Cのメモリが成立しない場合の代替 |

Native JPEGをPillow decodeして既存JPEG encodeする方式は二重非可逆圧縮になるため採らない。既存Preview上限を単純撤廃する案、別Queue/Runtime/page、NASへNative追加、JPEG Recipe v18へRAW設定変換も不採用。

正式推奨経路：

```text
既存Queue / Start transaction（JPEGまたはRAW snapshot固定）
 → 同じserial ExportRuntime
 → JPEG: 現行decoder + JpegRenderer
   RAW: 隔離Export Session + source照合 + 全settings復元
        + native export_job（原寸 / Full / sRGB8 / CPU）
        → bounded lossless bytes（提案契約）→ RenderedImage
 → 共通allowlist metadata再構成 + 既存JPEG encoder
 → ExportArtifact
 → 既存Immich registrar（Album/Stack/COVER/Favorite/tag）
```

新契約の名前やschema version番号は実装前のcontract設計で決定する。最低限、request/job ID、Native photo/source identity、settings fingerprint、engine tuple、render dimensions/space/quality、encoded bytes長/hash、metadata取得のmissing/invalid/unsupported区別、safe fixed errorを返す。完全settings本文は通常ログに出さず、原本pathをpublic responseに含めない。Native Exported.bytesを返すだけではfull settings固定とmetadata差を解決しない。

Session隔離は同じExportRuntime内の描画依存として扱う。初期はon-demand Export用childを既存managerの起動/attestation/cleanup基盤で管理する案を推奨し、編集用managerのsettingsを変更しない。**同時に重いRAW処理を走らせない共通admission**が必要。PreviewとExportのメモリを足して予算超過ならExport開始をboundedで待たせる／失敗させる。live編集sessionを無断reset/closeして節約しない。2 child分の常駐・cacheが成立しなければ、同一process内の独立Sessionを持つmanaged契約へ変更して限定PoCで再評価する。別Queueやworkerは増やさない。

## 9. 正式実装の段階案と残存リスク

1. **P0a：無書込PoC**。§7.1を既存EXE・隔離fileで実施し、metadata欠落、CPU決定性、時間/メモリを確定する。画質や機種対応はsourceだけで完了としない。
2. **P0b：Native契約の小さなPoC**。C案の原寸lossless transfer＋標準RAW metadata抽出、別Sessionとadmissionを固定。既存binaryでは不足するため、この段階で初めてmanaged patch更新・通常update guideに沿うbuild/receipt/schema受入を行う。今回は行わない。
3. **P1：保存snapshotとartifact境界**。RAW/JPEG variant、旧JPEG行互換、atomic eligibility/freeze/Retry identity、raw metadata adapterと既存serializer接続。migration設計はbackup/rollback/旧version拒否までレビューしてから実装。
4. **P2：既存Runtimeに描画接続**。同じserial worker、generation、Stop/recovery、Windows起動終了順、異常cleanupと固定failure。fake registrarで混在runを検証してからremote書込へ進む。
5. **P3：既存Frontend操作へ拡張**。RAW Q/badge/Stack候補、保存drain、format filter／Retry、capability guard。新設定UI／管理pageは作らない。
6. **P4：Immich正式受入**。既存registrarをそのまま用い、§7.3を利用者環境で確認。必要な利用者文書更新はこの完成確認後の別変更で判断する。

### 確定事項と未検証事項

**sourceで確定**：原寸API、quality/S444/sRGB条件、file出力の応答形、settings merge/readback経路、Native metadataの情報落ち、現行transport制限、JPEG-only store/runtime/UI guard、registrar再利用境界、recoveryの初期化順問題。

**PoCが必要**：Pixel/Pentax個別tagとRAW decode、現像後寸法・見た目、保存復元、CPU/GPU出力決定性、full-sizeメモリ/時間、lossless転送の上限、異常終了後の資源解放。実際のImmich重複判定・権限・Album/Stack収束は正式実装後の実機確認が必要。

特にCPU/DX12差やengine更新で同一snapshotのJPEG bytesが変わると、partial upload後Retry／recoveryの重複回復が破れる。ここは既存JPEGの安全仕様に直結するため、単にExport APIが呼べたことを完了条件にしない。分散filename予約なし、remote multi-step transactionなし、partial成功rollbackなしという既存の制約も継承する。

本調査で変更したのは本書のみ。製品・テスト・patch・既存設計書・README・CHANGELOGは変更せず、DB/migration、画像/Recipe/History書込、Native build、Immich mutation、Commit/Pushを行っていない。

## 10. 再確認用の主要ソース索引

リポジトリ内の根拠（行番号は今回の作業ツリー）：

- [JPEG artifactと命名](../../../backend/export_artifact.py)、[JPEG codec](../../../backend/jpeg_codec.py)、[metadata再構成](../../../backend/jpeg_metadata.py)：`create_export_artifact`、`encode_jpeg`、`prepare_metadata`（488行目）。
- [Runtime](../../../backend/export_runtime.py)：`_artifact`、`_process_item`。[Runtime store](../../../backend/export_runtime_store.py)：`_read_run`（75）、`create_export_run`（149）、`reclaim_export_run`（396）、`retry_export_assets`（425）。
- [Queue/保存store](../../../backend/edit_store.py)：`enqueue_export_assets`（434）。[RAW Recipe/History store](../../../backend/raw_recipe_store.py)：`get_raw_edit_statuses`（207）、`_save_history`、`restore`の入力validator。
- [RAW adapter](../../../backend/lightcraft_raw.py)：`_restore`、`restore_persisted_settings`。[MCP transport](../../../backend/lightcraft_mcp.py)：`request`、`call_tool_result`。
- [Immich登録](../../../backend/immich_export.py)：`ImmichFamilyFilenameProvider`（40）、`ImmichExportRegistrar`（89）。[Album regression](../../../backend/tests/test_immich_export_albums.py)：non-COVER、union、cleanup、partial-failure Retry。
- [Gallery Queue判定](../../../frontend/src/GalleryPage.tsx)：`queueStateFor`（1091）。[Filmstrip](../../../frontend/src/Filmstrip.tsx)：RAW badge action除外（100）。[管理画面metadata](../../../frontend/src/useExportQueueAssets.ts)、[RAW保存coordinator](../../../frontend/src/rawRecipeSave.ts)。
- [managed manifest](../../../native/lightcraft/manifest.json)、[適用patch](../../../native/lightcraft/patches/0002-v0.14-native-contracts.patch)。

固定managed source内の根拠（`.tmp/lightcraft-0.14/`以下）：

| ファイル | 主要箇所 |
|---|---|
| `crates/mcp/src/tools.rs` | export schema（239）、set_develop dispatch（739）、export dispatch（790） |
| `crates/mcp/src/headless.rs` | `Headless::export`（139）、`adaptive_render`、StagePoolとの分離 |
| `crates/mcp/src/server.rs` | cancelled通知無操作、同期tools/callとprogress hook |
| `crates/engine/src/export.rs` | `encode_with_metadata`（1383）、`export_metadata`（1568）、`output_size`（1632）、`prepare_guarded`（1710）、`PreparedExport::run`（1812）、`BatchWriter::place`（2289） |
| `crates/engine/src/media.rs` | `build_job`（1293付近）、`export_job`（1707）、`develop_reporting`、source/cache/GPU境界 |
| `crates/meta/src/lib.rs` | `Metadata`、`extract`（284）、`try_extract`（293）。RAWではbest-effortのためmissing/invalid識別に注意 |
| `crates/meta/src/container.rs` / `exif.rs` / `datetime.rs` | TIFF系・その他container、標準tag読取、millisecond正規化 |
| `apps/lightcraft-cli/src/main.rs` | `read_settings`（648）、`render`（670）、file writeとOriginalGuard |

文書のみの変更として、実行テスト・型チェック・production buildは対象外。静的照合、patch reverse-check、EXE/patch hash照合と文書の差分／空白検査を実施した。実RAW PoC・Native契約binary確認・ブラウザ／Immich実機検証は未実施。
