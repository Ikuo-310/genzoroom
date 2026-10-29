# RAW Export Phase 0 — 実装前調査

調査日：2026-10-29。対象：`feature/lightcraft-integration` のローカル作業ツリー。
本書は設計案であり、製品実装・実RAW PoC・Immich書き込みの完了記録ではない。

> **現行の確定方針（2026-10-29）**：RAWの現像とJPEGエンコードはLightCraftが行う。完成JPEGへGenzoRoomが撮影metadata・識別情報を付与し、JPEG圧縮データを再エンコードせず既存`ExportArtifact`／Immich registrarへ渡す。§11のP0aは旧推奨案を含む実測記録として保持し、本決定と異なる推奨・必須条件は本節・§12で置き換える。JPEGの現像・エンコード・Retry仕様は変更しない。

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
| Encoder | RAWはLightCraft内蔵JPEG encoderで品質95/4:4:4/sRGB ICCを生成。既存GenzoRoom encoderは使わない |
| メタデータ | RAW containerから許可リストの標準情報を抽出し、既存serializerの安全な検証・EXIF/XMP構成を再利用できるか確認。生成JPEGへmarker metadataだけを付与し、圧縮画像データを保持 |
| 登録 | `ExportArtifact(filename,jpeg)`とsource detailを渡す既存registrar。Album/Stack/COVER/Favorite/tag意味は変えない |
| 障害と診断 | item failure、Retry/recovery、safe code/ID中心のstructured logs。RAW現像・metadata処理の失敗境界を追加。JPEG byte一致やengine固定は追加しない |

`create_export_artifact()`はJPEG原本をdecodeしGenzoRoom encoderで再生成するため、RAW成果物へ流用しない。RAW専用Artifact生成処理でLightCraft完成JPEGをmetadata-onlyで更新して検証後、既存`ExportArtifact(filename,jpeg)`へ渡す。JPEG圧縮データは再圧縮しない。

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

現行RAW保存はschema 1、明示processと全settings、Asset ID、sourceContentHash、engine name/version/commitを保持する。version/commit差だけでは通常編集へのrestoreを拒否しない。RAW Exportも保存RecipeのEngine tupleを実行engineの固定条件にせず、古いRecipeを復元して現在engineで出力しても古いrowを書き換えない。

### 4.3 原寸・品質・色

| 条件 | ソースで確定できること | 注意 |
|---|---|---|
| 原寸 | `longEdge:0` は有効。`has_size_param`がtrueとなりheadless既定3000を回避し、resizeなしになる | `render_preview max_side:0` は代替にならない。PreviewはclampとBackend上限2048を持つ |
| 寸法 | `output_size`→`native_output_size`、crop/orientation/geometryを反映した現像後native寸法 | センサー格納寸法と常に同じではない。実RAWで期待寸法を検証 |
| 品質95 | `quality:95` → JPEG codecへ95を渡す | 「95」はcodec依存。Pillowの95と同じbytes／量子化表とは限らない |
| 4:4:4 | `encode_with_metadata` は `limitKb`なしならS444、ありならS420 | 明示subsampling引数はない。preset/limitKb禁止で条件固定 |
| sRGB ICC | `colorSpace:"srgb"`、8-bit SDRへ描画し `icc::write_named(Srgb)` を埋込 | LightCraft生成JPEGのsRGB ICCを検証し、GenzoRoom encoderで置換しない |
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
- ExportはCPU/DX12のどちらも許容する。§11 P0aで各方式を動作・性能測定したが、CPU/DX12 byte一致やcross-process GPU一致は確認しておらずRAW要件でもない。実行backendは利用可能なら診断用に記録し、fallbackやNative failureは通常のitem failure/retryとして扱う。JPEGの重複回復保証は変えない。

### 4.6 転送・timeout・cancel・無変更保証

標準MCP Exportは同期的に指定pathへ完成JPEGを出力し、画像bytesをresponseへ含めない。初期案ではBackendが所有するjobごとの隔離fileへ書き、完了後にJPEGをstream/chunkで読み出してbounded validation・metadata updateし、成功／失敗どちらでも一時fileをcleanupする。画像返却用のPreview APIは使わない。Native `Exported.bytes`のMCP転送拡張は必須でない。

現行 `backend/lightcraft_mcp.py`の通常1 MiB／Preview 24 MiB／Region 13 MiB、`lightcraft_raw.py`のPreview17 MiB・settings256 KiB・長辺2048上限は現行契約であり、原寸Export response上限ではない。JPEG file取得後に必要なfile・メモリ・MCP処理deadlineと、ICC/EXIF/XMP等のAPP marker上限をP1で設計する。PNG/Base64転送の上限候補は現方針に適用しない。

現行manager timeoutはrequest5秒、gpu15秒、RAW adapterはimport/preview60秒・command5秒。Export専用timeoutは未実装。PoCでcold/warm full-size時間を測り有限上限を決める。送信後timeout/cancelはtransportをabortしgenerationを失効する。Native serverの `notifications/cancelled` は無操作で、同期decode/renderを途中停止しない。Stopはこの機構を使わず、現行どおりcurrent item完了を待つ。強制終了はtimeout/異常終了専用とし、出力未確認時は登録しない。process再生成後はimportとfrozen settings restoreからやり直す。

JPEG Export自体はNative DevelopSettingsを編集せず、新しい `RenderJob`にsnapshotを持たせる。`OriginalGuard`は原本・sidecarへの出力を拒否する。一方、復元のreset/mergeはNative Session内settings/Undoを変更する。**編集用live sessionをそのまま書き換える案は不採用**。隔離したExport Sessionで実行し、GenzoRoom Recipe/Historyのsave APIを呼ばない。

LightCraftにはXMP auto-writeもある（`engine/src/lib.rs:execute`、`sidecar.rs:XmpPrefs`）。原本保護をpath guardだけに任せず、Export専用Sessionをin-memory・auto-write off・永続libraryなし・Backend所有の原本copyだけで動かす。原本hashとRecipe/History行が前後で不変、予期しないsidecarが作られないことは正式実装のテスト／PoCで確認する。Native一般機能全体が無書込とは言わない。

## 5. EXIF/XMP継承方針

### 5.1 原則と取得経路

`jpeg_metadata.py`は画素decodeと独立したallowlist再構成だが、入口が `Image.open(JPEG bytes)` に結合している。RAW metadataをPillowで開けると仮定せず、raw container抽出 → typed allowlist値 → **共通validatorとserializer**へ接続する。既存JPEG入口は互換性を維持する。LightCraft JPEGのEXIF/XMPを正本にせず、必要情報は原RAWから得る。

managed `crates/meta/src/container.rs` はTIFF/DNG等、CR3、MRW、RAF等のcontainer抽出を持つ。`lightcraft_meta::Metadata`は共通型へ正規化するため、全標準tag／元表現を保持しない。`export_metadata()` はさらにcatalogのsubsetへ落とす。既存 `photo.inspect` 等の表示metadataも完全EXIF取得APIではない。

第一候補はGenzoRoom側でRAW原本からallowlistの標準tagを抽出し、LightCraftの完成JPEGへmetadata-onlyで付与する方式。既存JPEG metadata処理にJPEG source parsingとEXIF/XMP serializationが結合しているため、JPEG画像データを保つmarker-only更新を小さく安全に実装できる既存ライブラリ／Pillowの機能を調査し、再圧縮なしをbytes-levelで検証する。元TIFF blockはRAW全体を含み得るためBackendへ丸ごと返さない。MakerNoteの再配置／無条件コピーやvendor serialの保持はしない。

RAW container parserは、対応形式・依存配布・malformed container制限をPoCで評価して選ぶ。まずは既存Backend依存や安全な標準機能で実現可能か調査する。LightCraft `Metadata`は標準tagの一部と catalog subsetで情報が落ちるため、それだけで要件が満たせるとはしない。GenzoRoom側の方法で必要tagを安全に取得できず、Native既存機能の追加が明らかに小さく更新保守も軽いと確認できた場合のみ、追加Native patchを代替案として再評価する。新しいNative patchを前提にしない。

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

- **出力必須**：検証済みLightCraft JPEG、現像後寸法、upright、sRGB8/ICC、品質95/4:4:4の要求条件、Software/CreatorTool、妥当なexport timestamp、入力sourceとfrozen snapshotの所有関係。JPEG圧縮データを変更せずmetadataだけを更新する。Engine/backend間の画素やbyte一致は必須にしない。
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
| 実行engine | 保存Recipeのsettings/processをsnapshotへ固定。実行に利用したLightCraftのversion/backendは診断情報として記録候補だが、古いengineやCPU/GPU policyを固定しない |
| item timestamp | 既存storeのrun item値を成果物metadataへ渡す。RAWではtimestampやRetryによるJPEG bytes一致を契約にしない |
| Native PhotoId/generation | 1回のExport実行のみ。DBへ保存しない。再起動時は原RAW再取得・hash照合・再import・全settings復元 |
| 出力bytes | itemローカルのみ。DB/cacheへ永続しない。検証済みartifactだけregistrarへ渡す |

enqueue→Startの間に編集した場合はStart時の最新保存revisionを採用する。enqueueでRecipeを固定しない。暗室QはRAW gestureをdrainして既存 `prepareSave` に相当する保存確認を完了し、成功後にenqueue。Home/Exportは未保存live stateを直接読まない。

Start後の追加編集・Undo/Redo・default resetはrun itemを変更しない。RAW通常save/resetによるQueue cleanupもJPEGと同じくqueued/failedだけを同じDB transactionで解除し、activeは残す。現 `raw_recipe_store.py` はこのQueue cleanupを持たないので追加が必要。ResetがRecipeを削除してもactive frozen settingsで完了できるよう、処理をlive編集sessionやcurrent DB行へ依存させない。

RAW rowはidentity別に複数存在し得る。`get_raw_edit_statuses` はupdated_at降順→recipe_revision降順で最新rowを選び、`importDefaultsFingerprint`、旧行ではHistory baselineを比較、判定不能はNone。Export用selection/eligibilityを同一writer transactionで共用するhelperが必要。完全同時刻・同revisionの異なるidentityのtieは現照会に最終tie-breakがないため、Exportでは曖昧な候補をfail closedとし、通常表示と不一致を生まない共通化を実装時に決める。最初に見つかったrowを推測で採用しない。

Retryでは既存仕様どおり新run作成時点の保存Recipeを採用する。RAWの再生成結果はEngine version更新やCPU/DX12差で画素・bytesが異なってよい。JPEG用のRetry identity・timestamp再利用・byte一致機構は変更しない。RAWで同一failure後に部分Assetが登録済みか判断できない場合や`-GenzoNN`が競合した場合は、現在のfamily検索とImmich duplicate応答で実際にどう処理されるかを§12の受入項目として検証し、重複Assetを許容する。新しいbyte一致契約やEngine固定で抑止しない。

再起動復旧では既存Runtimeのfrozen RAW Recipeを現在利用可能なLightCraftで復元し、処理・登録を先頭から再実行する。停止・通常失敗・metadata failureのqueue状態は共通Runtimeの規則を使う。既存JPEGのbyte-stable recovery/dedup契約はそのまま維持し、RAWには持ち込まない。

### 6.2 Backend接続箇所

| ファイル／境界 | 必要な差分 |
|---|---|
| `edit_store.py:enqueue_export_assets` | 現在はJPEG `asset_edit_states`のみ。RAW row/適格判定も同一transactionで扱う。APIのAsset ID配列契約は維持 |
| `raw_recipe_store.py` | 最新保存選択・baseline適格判定の共通化、default save/reset時のmutable Queue cleanup。Recipe/History本文・形式は変更しない |
| `export_runtime_store.py` | JPEG専用validator、frozen columns/serialization、create/retry/read/reclaimのRAW variant。旧JPEG run/Queueとfailure code互換 |
| `export_runtime.py` | detail.format/is_rawのJPEG専用拒否からsnapshotに従う適格source検証へ。JPEG `_artifact`を保持し、RAW描画adapterを追加。serial worker/Stop/registrarは共有 |
| `export_artifact.py` / 新RAW artifact / `jpeg_metadata.py` | JPEG実装は維持。RAW用artifact builderでLightCraft JPEGを検証し、RAW parserのtyped allowlist値からmetadata-only更新。Marker追加で画像scan/entropyが不変なことを検証。共通命名と`ExportArtifact`型を再利用 |
| LightCraft manager/adapter | 現行Export APIによるJPEG生成、専用job lifetime、保存済み全settings復元、原寸出力、finite timeout、Native photo/source identity照合、cleanup。PNG/Base64転送拡張や追加Native patchを必須にしない |
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

この節はP0a実施前の計画記録であり、実施結果は後続の§11に記録した。現行方針での次の検証はP1設計の下で行い、Immichへの書き込みを行わない。新build環境を作らず既存attested EXEを使う。利用者の指定したPixel DNGとPentax RAWの**copy**を小さな隔離tempへ置き、原本／copyと保存Recipe/Historyを読み取り対象として扱う。settings JSONはtemp copyだけを作る。永続LightCraft libraryなし、XMP auto-write off、network登録なし。共有DBへのsave/migrationを起動しない。

1. source hashと既存保存identity・全settingsを取得。各RAWにつきdefaultと、保存済みの目立つWB/露光/色・geometryを含む代表設定を選ぶ。対応UIにない設定を推測で作らない。
2. 隔離MCP Sessionでimport→select→reset→merge全settings→get/readback一致。前後settings/source hash/sidecar有無を確認。
3. §4.1の明示要求でJPEGを隔離出力。full-sizeをcrop/orientation込みのNative計画と実JPEG SOF寸法で照合。品質95は呼出条件とcodec経路で確認し、SOF sampling factorが全component 1×1（4:4:4）、ICCが読めるsRGBであることを独立parserで検査。「JPEGの品質値95」という標準tagがあるとは扱わない。
4. Native raw metadata→catalog→Native JPEGの差をtag単位で採取し、表§5の欠落を実fixtureで確定。特にPixelのoffset/subsecond/GPS方向、Pentax camera/lens/露出。値や原本pathsを通常ログへ書かず、PoC成果は限定公開の検証資料として管理。
5. P0aではNative PNGから既存encoderへ渡す案も試験した。実施値は§11の履歴データとして保持するが、製品方式としては不採用。P1 PoCではLightCraftが生成したJPEGのsRGB/ICC、品質95、4:4:4、寸法を検証し、metadata-only更新前後のJPEG compressed scan bytesが同一であることを確認する。
6. settled Full After Previewと原寸結果の縮小を並べる。default/代表編集、保存→新Session復元の結果を比較。Before/RegionやDraftを基準画像へ混ぜない。目視は利用者のWindows実機確認とし、自動pixel差と区別。
7. Retry／再起動でfrozen settingsが復元され、原本とRecipe/Historyを変更しないことを確認する。CPU/DX12の動作・時間・メモリは性能情報として測定し、画像・byte一致条件や固定backend policyにはしない。
8. malformed settings／復元不一致、出力dir不可／disk full相当、timeout／process終了時に成果物が登録扱いにならないこと、原本hashと保存Recipe/Historyが不変なことを確認。PoCはImmich upload/tag/Album/Stackの呼出を一切持たない。

この次段階の合格条件：両fixtureでLightCraft完成JPEGが原寸・当面のJPEG条件を満たす、保存復元後の代表設定が反映される、metadata allowlistの取得・欠落一覧が整理される、metadata追加が画像compressed scanを変えない、失敗時も原本・Recipe/Historyが不変。決定的JPEG checksumは条件としない。Native patchによるbytes転送は必須でない。

### 7.2 正式実装後の自動テスト

既存テストを基礎に差分を追加する。以下はテストの読取による対応表であり、今回実行した結果ではない。

| 既存coverage | 追加する回帰／統合境界 |
|---|---|
| `test_export_artifact.py` / JPEG codec/renderer tests | JPEG bytes・metadata互換維持、RAW allowlist、malformed/overflow/DTD、二重回転／二重JPEGなし |
| `test_raw_recipe_store.py` / `test_raw_history_store.py` | verified default／non-default／unknown、旧baseline、複数identity、Undoでdefault、save/resetとQueue cleanupのatomicity |
| `test_export_queue.py` / `test_export_runtime.py` | RAW/JPEG混在、100件atomic freeze、保存競合、Start後編集、kind/source mismatch、serial順とbuffer解放 |
| `test_export_recovery.py` / `test_export_retry_identity.py` | current RAWでStop、未開始release、generation喪失、再import/restore、現行Engineで再開、JPEG後続継続。厳密なRetry identity/timestamp再利用テストは既存JPEG仕様を維持し、RAWへ適用しない |
| `test_lightcraft_mcp.py` / runtime/raw/patch tests | 新契約schema・実応答、上限、timeout/cancel、invalid pixels/dimensions/hash、process reap、原本/sidecar不変、live編集を変更しない |
| `test_immich_export.py` / `test_immich_export_albums.py` | RAW sourceと生成JPEGでFavorite ON/OFF、tag、non-COVER source、Album union→新COVER→cleanup、partial retry duplicate収束をfake transportで確認 |
| Frontend Queue/管理/RAW保存 tests | Q保存drain、unknown拒否、RAW/JPEG Stack任意member、format filter、locked/failed解除、Retry優先、uncertain Start/canonical refresh、engine unavailableでも解除可能 |
| Windows lifecycle tests | readiness前recovery、shutdown drain、timeout child cleanup、JPEG readiness非依存、Docker RAW providerなしでJPEG動作 |

Frontend/Backend両側の関連tests、TypeScript、production build、diff checkが必要。広範なstore/snapshot変更なのでmigration rollback、旧JPEG run回復、混在failure境界の検証は必須。全suiteを実施するかは実際の変更範囲とfocused coverageの不足を説明して判断する。routineのfull Docker smokeは行わない。

### 7.3 正式実装後の利用者実機確認

WindowsのPixel/Pentax実RAWでPreviewとの見た目、原寸・保存復元・Stop待ち時間・メモリを確認。Immich書込はこの正式検証段階で別途行う。RAW/JPEG混在Queue、単独RAW、RAWが非COVERのStack、Albumなし／複数Album、Favorite ON/OFF、partial Album failure Retry、再起動を確認する。

AlbumはImmichの**生membership**とnative UI、新COVERと旧member、GenzoRoom Galleryを併せて検証する。Gallery枚数だけで合格にしない。原RAWと既存Recipe/History不変、生成JPEGのSoftware/ICC/tag、既存JPEG ExportのNAS回帰も利用者確認項目。今回ブラウザ起動・NAS確認・Immich書込は実施していない。

## 8. 旧案の比較（現行決定は§12）

| 案 | 利点 | 制約／判断 |
|---|---|---|
| A. 既存MCPでlossless原寸PNG temp→Backend既存JPEG encoder | Native変更なしで画素・色・時間のPoC可能 | **P0aで技術的に成立したが、製品方式として不採用**。PNG転送・既存encoder共用は現行方針に不要 |
| B. 既存CLI `render` | 1回のprocessに隔離、`--settings`と `--size 0 --quality 95 --opt colorSpace=srgb --opt hdr=false --opt sharpen=none --opt metadata=none` 等で既存engine利用 | 入力/設定/出力fileが必要、毎回import/decode、readback契約が弱い。`--settings`もmerge。stdout bytes返却はない。再圧縮回避にはPNG出力。MCPより有利かは実測。fallback候補 |
| C. 現行LightCraft Export file＋GenzoRoom metadata-only更新 | 既存APIの完成JPEGを保持。追加Native patch不要、JPEG再圧縮なし。完成JPEGを既存Artifact/registrarへ渡せる | GenzoRoom側でRAW allowlist抽出と、JPEG marker/EXIF/XMPのbounded更新を実装・検証する |
| D. Native JPEG bytes＋JPEG marker単位のmetadata mux | 圧縮データを一度だけ生成、transferは小さい | 現行APIはfile出力。bytes応答にはNative変更が必要。metadata取得も解決しない。GenzoRoom側の方式よりNative patchが明らかに小さく、保守負担も低いと確認できる場合だけ代替再評価 |

LightCraft JPEGをPillow decodeして既存JPEG encodeする方式は二重非可逆圧縮になるため採らない。既存Preview上限を単純撤廃する案、別Queue/Runtime/page、NASへNative追加、JPEG Recipe v18へRAW設定変換も不採用。

正式推奨経路：

```text
既存Queue / Start transaction（JPEGまたはRAW snapshot固定）
 → 同じserial ExportRuntime
 → JPEG: 現行decoder + JpegRenderer + GenzoRoom encoder
   RAW: LightCraft隔離Export Session + source照合 + frozen settings復元
        + LightCraft export（原寸 / sRGB / quality95 / 4:4:4）
        → 完成JPEGを一時成果物として取得・検証
        → 原RAW由来allowlist metadataを付与（marker-only、再圧縮なし）
 → ExportArtifact
 → 既存Immich registrar（Album/Stack/COVER/Favorite/tag）
```

LightCraft現行MCPは同期Exportをfileへ書き出し、画像bytesを応答しない。Backend所有の隔離先へ書き出して取得・検証する案を第一候補にする。request/job ID、Native photo/source identity、settings readback、Native export path/サイズ、出力寸法・色・sampling/ICC、metadataのmissing/invalid/unsupported区別、safe fixed errorを検証する。Export bytes転送契約やoutput hashをRetry同一性へ使う要件は設けない。完全settings本文・原本pathを通常ログ/public responseに含めない。Native JPEG出力後のGenzoRoom metadata更新は、画像scan/entropyを保持したことを検証する。

Exportは暗室live settings/Historyを変更しない隔離されたjob/session境界を使い、同じExportRuntimeのserial workerで実行する。P0aで測定したLightCraft process memory/timeを初期見積に使い、正式実装時にはPreviewと共存する状態で必要な有限上限を確かめる。CPU/DX12どちらも許容し、性能・driver failure時の通常失敗処理を設ける。byte一致を実現するための追加admission、CPU固定、engine attestationは導入しない。別Queueやworkerは増やさない。

## 9. 正式実装の段階案と残存リスク

1. **P0a：隔離PoC完了**。実測は§11を参照。LightCraft JPEGの原寸・色・sampling、RAW metadata差、CPU/DX12時間・メモリ、Preview比較を記録済み。PNG→GenzoRoom encoderは成立した技術検証であり、製品方針では不採用。
2. **P1：LightCraft JPEG・metadata-only Artifact**。保存RAW Recipe復元後、LightCraft JPEG Exportを実行するRAW専用adapter/artifact生成を実装。RAW標準metadataの取得・allowlist再構成、jpeg compressed scanを変えないEXIF/XMP/ICC整合、品質95/4:4:4/sRGB/原寸の検証、filename・ExportArtifact接続を行う。Native patchは前提にせず、必要性と保守差が確認された場合だけ再評価する。
3. **P2：既存Export Queue／RuntimeへRAW対応**。Queue/Startの保存状態・Recipe snapshot、schema/validatorと旧JPEG行互換、single serial worker、Stop/Retry/restart recovery、Windows lifecycle/readinessを接続。RAW RetryはJPEG byte identityを求めず、不確定な部分登録・連番競合時の実挙動をテストする。Immich登録とStack管理は既存registrarに委譲する。
4. **P3：Frontend Queue・Export管理統合**。Gallery/Filmstrip/暗室のRAW Queue操作、保存drain、RAW適格性、mixed format filter/status/Retryを既存UIへ接続。新設定UI・RAW専用管理ページは作らない。
5. **P4：統合受入・最終監査**。Pixel/Pentax実RAW、Preview/保存復元、mixed Queue、Immich Favorite/tag/Album/Stack/COVER、失敗・Retry・再起動を受け入れる。生Album membershipも確認する。必要な利用者文書更新は完成確認後に判断する。

### 確定事項と未検証事項

**sourceで確定**：原寸API、quality/S444/sRGB条件、file出力の応答形、settings merge/readback経路、Native metadataの情報落ち、現行transport制限、JPEG-only store/runtime/UI guard、registrar再利用境界、recoveryの初期化順問題。LightCraft JPEGは既存APIから直接得られ、GenzoRoomでの再エンコードは不要。

**追加PoC/実装検証が必要**：複数RAW形式における標準EXIF/XMPの直接抽出・悪意あるcontainer上限、既存serializerのRAW metadata入力、LightCraft JPEGへEXIF/XMPを追加した際のcompressed scan不変、EXIF Orientation/dimensions/sRGB ICCの整合、実保存Recipe、Preview/Exportの利用者受入、出力file失敗時cleanup。実際のImmich partial result、duplicate応答、filename競合、Album/Stack収束は正式統合後の実機確認が必要。CPU/DX12間やengine version更新後のbytes/checksum一致は要件ではない。

既存JPEGのpartial upload回復はJPEGの現像・encoder identityで成立しているため、その仕様は変更しない。RAWではRetry／recoveryの再現性より、現在のLightCraftでfrozen Recipeを再実行し元RAW等を保護することを重視する。Immichのmulti-step登録、分散filename予約なし、partial成功rollbackなしという共通制約は継承し、RAWで不確定結果となる場面は許容重複も含め明示して検証する。

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

先行調査は文書のみの変更で、実行テスト・型チェック・production buildは対象外だった。静的照合、patch reverse-check、EXE/patch hash照合と文書の差分／空白検査を実施している。P0a時点で新しいExport契約のbinary確認、ブラウザ／Immich実機検証は未実施だった。

## 11. P0a実施結果（2026-10-29）

**P0a当時の総合判定（後続設計で superseded）**：P0bの限定契約PoCへ条件付きで進行可能としていた。原寸JPEG、PNG→既存EncoderとCPU内再生成の計測結果は引き続き有効。一方「PNGがPreview転送上限を超えたのでP0b Native bytes契約が必要」という設計上の帰結は§12で撤回した。これらは製品RAW Exportの完成・利用者の画質受入を意味しない。

§1～10には先行調査時の実装観測と提案が含まれる。後続方針との違いは§11.8と§12で明示した。「未実施」等の履歴記述はそれぞれの調査時点を指す。本節がP0aの実測記録であり、ここに記載のない製品実装・Immich登録・ブラウザ確認は行っていない。

### 11.1 環境・固定identity・原本保護

| 項目 | 確認結果 |
|---|---|
| GenzoRoom | `feature/lightcraft-integration`、開始HEAD `2842e0c9a622e8fe3b78477f72cfaf102be57649`、開始時working tree clean |
| OS / CPU / RAM | Windows 11 Pro build 26300、AMD Ryzen 7 3700X（8 cores / 16 logical processors）、物理RAM約31.92 GiB |
| GPU | Radeon RX 580 Series、DX12。VRAM peakは未測定 |
| Python / libraries | repository `.venv` Python 3.14.5、Pillow 12.3.0、NumPy 2.5.3。製品の既存 `jpeg_codec.encode_jpeg` / `RenderedImage` をそのままimport |
| LightCraft | v0.14.0、upstream `03c88c166c054c009db2a47187d59991f6232b85` |
| patch | `0002-v0.14-native-contracts.patch`、SHA-256 `9308d0663de3e4d1f6fd65e564fb04cc7ac1c993b5c1a2aae29ef1f72b521063`。reverse `--check`成功、適用状態の変更なし |
| EXE | 既存 `target-wb-phase1/release/lightcraft-cli.exe`、SHA-256 `b872315ccd11c5c2e945f473d8ca48022127a4cc196b95d16ff3d8fb75004251` |
| attestation | 実EXE hash・隣接receipt・manifest tupleを製品 `verified_artifact` で照合。実MCP initializeでversion確認。tools/listでExport/Preview schema確認、Full After Preview契約1の実応答を取得 |
| Session | `mcp --headless --compact`、永続libraryを開かず、import前に `library.xmpPreferences {autoWrite:false}`。Backend製品serverとImmich clientは起動せず、OS runtimeのallowlist環境だけを子へ渡した |
| CPU条件 | `LIGHTCRAFT_GPU=0` / backend off。スレッド数上限・CPU affinityは追加せずNative既定、同時RAW処理なし |
| DX12条件 | backend dx12、app.gpu enabled/availableを確認。Preview実応答は `gpu_success`。ExportにgpuFallbackなし、最終lastFallbackなし。ただし標準Export応答にper-job execution証明はなく、全stageのGPU実行を証明したとはしない |

既存研究資料で所在が確認できるPixel DNGとPentax DNGを使用した。入力はそれぞれ16,422,322 bytes / 20,529,090 bytes。実パス・撮影日時・位置・原画像は本書へ載せない。両原本をGit管理外の隔離先へコピーし、コピー前後のSHA-256一致を確認した。終了時も両原本・コピーのhash、原本directoryのentry一覧が不変、copy隣のXMP追加なしを確認。

実ユーザーのGenzoRoom標準保存先から5 DBを発見し、DB/WAL/SHM計11 fileのhashを記録して隔離コピー上だけで照会した。元SQLite接続・migration・saveはしていない。SHA-256と実importのNative source hashの両方で検索したが、この2素材に一致する保存済みRAW Recipeはなかった。終了時は11 fileのhashとDB sidecarの存在集合も不変。**実保存Recipeによる復元は未実施**であり、以下の代表設定による完全settings復元と区別する。

通常sandboxではPythonの非同期処理開始前に停止したため、同じrepository Pythonで権限付き実行へ切り替えた。待機したPoC用Pythonだけを終了し、重複Native起動を防いだ。Native再ビルド、checkout/target作成、実ディスク枯渇、OSメモリ枯渇、Immichへの通信・書込は行っていない。

### 11.2 試験条件・結果一覧

初期設定はImport後にFull 1024px Previewを一度生成してas-shot WB解決を済ませ、`get_develop`で全settingsを固定した。代表設定は公開controlsからExposure +0.7、Contrast +12、Dehaze +15、Vibrance +10、WB Temp 6000 / Tint +8を設定し、中央80% crop（x/yとも0.1～0.9）とRotate90を追加して全settingsを固定した。保存Recipe由来ではない人工的な検証設定である。

各Sessionで明示PhotoId選択→reset→full merge→get/readback完全一致を確認。Export後もsettings一致を確認した。初回harnessで配列tool結果をstructuredContentと仮定したため代表設定準備が失敗したが、配列text JSONを解析するよう**一時スクリプトのみ**修正し、未完了の代表条件だけ再実行した。これはEngine不具合や合格試験には数えない。

| 試験 | Pixel | Pentax | 判定の範囲 |
|---|---|---|---|
| 初期・代表 settings完全復元/readback | PASS | PASS | Nativeメモリ内snapshot。実DB Recipeではない |
| 原寸JPEG・PNG・既存Encoder JPEG | PASS | PASS | 初期と代表、CPUとDX12要求の両方 |
| crop/orientation期待寸法 | PASS | PASS | 下表。格納RAWや埋込thumbnailの寸法を原寸と混同しない |
| JPEG SOF precision/sampling、ICC | PASS | PASS | 8-bit、3 componentとも1×1、sRGB ICC |
| CPU Cold2＋Warm2の決定性 | PASS | PASS | 各設定・各形式でhash/bytes/寸法一致 |
| DX12同一process内2回の決定性 | PASS | PASS | 各設定・各形式。別process間GPU決定性は未実施 |
| PNG→既存Encoder接続 | PASS | PASS | lossless PNG→RGB8→製品encoder、一度だけJPEG化 |
| metadata none | PASS | PASS | EXIF/XMPなし。ICCは存在。意図した条件 |
| 標準Export metadata allによるJPEG継承同等性 | 未達 | 未達 | 比較用に追加出力。重要tag欠落。§11.4 |
| Previewとの数値・生成画像比較 | 実施 | 実施 | 細部差あり。Windows実画面の利用者受入は未実施 |
| 不正settings/出力先/書込/Native終了 | PASS | PASS相当の終了試験 | 詳細は§11.7。全異常を機種ごとに重複実行していない |
| 原本・Recipe/History保護 | PASS | PASS | file hash・directory・元DB hash不変 |
| Immich登録・mixed Queue・製品Retry/recovery | 未実施 | 未実施 | 製品未接続。PoCから呼ばない |

### 11.3 寸法・JPEG条件・Encoder接続

本試験のExport指定は `format:jpeg/png, longEdge:0, quality:95, colorSpace:srgb, bitDepth:8, hdr:false, sharpen:none, metadata:none, addToPhotos:false`。limitKb/watermark/presetは未指定。PNGでも同じ明示条件を送り、PNGはlossless中間表現として扱った。

| 素材・設定 | 期待＝実測寸法 | CPU Native JPEG bytes | CPU PNG bytes | CPU既存Encoder JPEG bytes |
|---|---|---:|---:|---:|
| Pixel 初期 | 4064×3056 | 4,428,845 | 18,128,685 | 4,611,599 |
| Pixel 代表 | 2445×3251 | 3,235,545 | 11,766,965 | 3,377,417 |
| Pentax 初期 | 5472×3648 | 10,181,055 | 35,117,928 | 10,753,022 |
| Pentax 代表 | 2918×4378 | 7,081,936 | 21,928,562 | 7,427,808 |

独立TIFF header walkでPixel RAW IFD 4080×3072、DefaultCropSize 4064×3056、Pentax RAW IFD 5504×3664、DefaultCropSize 5472×3648を確認。初期出力はDefaultCropSizeと一致する。初期orientationはいずれもNormal。代表は80% cropと軸交換から独立計算し四捨五入した寸法に一致し、Native応答の寸法とJPEG SOF寸法も一致した。これで過去研究に残っていたsample2の格納／crop寸法の未確認を、この入力について埋めた。

JPEG markerを別途走査し、Native/既存EncoderともSOF 8-bit、3 componentのsampling全て1×1（4:4:4）を確認。Pillow/LittleCMSでICCを読み、RGB→XYZ profile、sRGB descriptionを確認。CPU4条件×Native JPEG/PNG/既存Encoderの計12 profileについて216色gridをcanonical sRGB profileへ変換した最大差は0/255。DX12各出力も同じheader/ICC検査に合格した。品質95は要求と固定sourceの `encode_with_metadata`→S444／品質95、既存 `encode_jpeg`→quality95/subsampling0の経路で確認した。JPEG内の品質tagから判定したものではない。

PNGはRGBとして読み、ICCの色空間を確認したうえで、追加色変換・補正・orientation操作をせず `RenderedImage(width,height,rgb.tobytes())` へ渡した。LightCraft JPEGをdecodeしてJPEG化する経路は使っていない。EXIF/XMP再構成はこの接続PoCに含めず、生成JPEGのSoftware等が製品仕様を満たすとは報告しない。

PNG画素を基準にJPEG復号画素を比較したPSNR（dB）は、Pixel初期 Native 43.33 / 既存Encoder 43.22、代表42.41 / 42.32、Pentax初期38.85 / 38.78、代表38.63 / 38.56。既存EncoderのfileはNativeより約4～6%大きい。どちらも一度のJPEG圧縮であり、同じ品質数値でも別codecのbytesや誤差は一致しない。PSNRだけで主観的な画質の優劣は決めない。

### 11.4 RAW・MCP metadata・生成JPEGの比較

原RAWをboundedな独立TIFF/EXIF/GPS walkerで解析し、MCP `photo.inspect` のcatalog metadataと比較した。標準reader内部のMetadata型はMCP catalogと同じではないため、「catalogで未公開」と「Native内部でも取得不能」を同一視しない。さらに各素材1枚ずつ `metadata:all` の比較用JPEGを隔離生成し、実EXIF/XMPを検査した。通常条件 `metadata:none` の全JPEGはEXIF/XMPを持たないので、そこでの欠落は仕様どおり。

分類：**取得**＝原値取得・数値同等、**変化**＝表現／型／精度の変化、**欠落**＝原RAWにあるが公開catalogまたは標準Exportで失う、**なし**＝対象の公開標準tagが原RAWにない。非公開MakerNoteを調べて無理に補完はしない。

| 項目 | Pixel | Pentax | 既存allowlist／RAW adapterへの意味 |
|---|---|---|---|
| DateTimeOriginal | 取得。標準JPEGの秒まで一致 | 取得。標準JPEGの秒まで一致 | 原標準tagを既存date validatorへ渡せる |
| OffsetTimeOriginal | 原RAWあり、catalogと出力XMP日時にはoffsetあり、出力EXIFでは欠落 | 原RAWになし | 原tagからEXIFへ再構成が必要。XMP日時があるだけで既存EXIF継承達成とはしない |
| SubsecTimeOriginal | 原6桁→catalog/XMPは3桁。出力EXIFでは欠落 | 原RAWになし | 元文字列をadapterで保持。Native正規化から6桁を復元不能 |
| Make / Model | Make原tagはcatalogのcameraへ結合。出力Make欠落、Modelは結合表現へ変化 | Make欠落、Modelはcamera由来の表現へ変化 | 両tagを原RAWから分離取得する必要 |
| LensMake / LensModel | LensMake欠落、LensModelは原値一致 | 両標準tagなし | PixelのMakeを失わないadapterが必要 |
| LensSpecification / DNG LensInfo | 両方なし | 両方なし | 存在するfixtureでの継承は未検証。値を推測しない |
| ExposureTime / FNumber / ISO / FocalLength | 取得。Native JPEGの数値は原tagと同等 | 同左 | rational→表示文字列/float→rationalという変化あり。adapterは元型を直接共通validatorへ |
| ExposureBiasValue / 35mm焦点距離 | 原RAWあり、catalogと標準JPEGでは欠落 | 同左 | 公開標準tag直接抽出が必要 |
| GPS緯度経度/ref | 原RAWあり、catalogはsigned decimal、標準JPEGはDMS/refへ変化 | 標準GPSなし | 型・範囲・変換精度の検証が必要 |
| GPS高度/ref、日時 | 原RAWあり、catalog／標準JPEGで欠落 | 標準GPSなし | 高度、GPSDateStamp、GPSTimeStampをadapterで取得 |
| GPS撮影方向/ref | 原RAWになし | 原RAWになし | 取得可能性の実機検証は未実施。Native共通型不足は先行source調査どおり |
| Artist / Copyright | tagなし | tagはあるが空文字、catalog／出力では省略 | 非空作者・著作権の実RAW往復は未検証。空値省略を情報喪失と数えない |
| ImageDescription | なし | なし | 非空fixture未検証 |
| XMP DC title/description/creator/rights/subject | 対象propertyなし | 同左 | 非空配列・Unicode実RAW往復は未検証。既存bounded allowlist parserの再利用候補 |

`metadata:all` のNative JPEGはSoftware=`LightCraft`、XMPもNativeが生成する。原本packetそのものではない。PixelのXMP `exif:DateTimeOriginal` はoffsetと3桁fractionを保持するが、原6桁やEXIF Offset/Subsec tagを補う契約にはならない。最終JPEGでは既存serializerでSoftware/CreatorTool=`GenzoRoom`、Orientation=1、rendered寸法、ColorSpace=1、永続timestampを作る必要がある。

ここで「なし」は標準tag／対象XMP propertyの不在であり、MakerNoteや未知namespaceに類似情報がないという主張ではない。Lens/説明/DC/GPS方向の非空fixture不足は後続coverage課題として残す。RAW metadata adapterは元tagを安全に読み、既存validator/allowlistで再構成する境界が必要。LightCraft JPEGのmetadataやMCP catalogだけを原RAW撮影情報の代用にする案は不採用。

### 11.5 再生成の決定性

CPUでは各素材・各設定について、Session 1の初回、別processのSession 2初回、その同一process内のWarm1/Warm2の計4回を比較した。Coldは「別Native process」であり、OS file cacheをcold化した試験ではない。各Sessionはsettings凍結前にbootstrap Previewを行っている。Native JPEG・PNG・既存Encoder JPEGそれぞれのSHA-256、bytes、寸法は全て一致した（CPU 4条件×3形式×4反復）。

CPU Native JPEGの基準hash：

| 条件 | SHA-256 |
|---|---|
| Pixel初期 | `dabdbc296fd13ab7ea576c2aef0a3d03eda0b499ba32409180470ef48388100c` |
| Pixel代表 | `ac7fa17ebef96969ddf3762f97de9915843fce147a72f078a3c30f92cb2e4dfb` |
| Pentax初期 | `7473775b7e8e7caea7fd532fcec1a7f1da177314ca3e8b9fff8f7ec1c0505d98` |
| Pentax代表 | `1cc12a971cd9eef376971cdfd18abf591e5b479cd3a78ada4f40db1caab31d29` |

DX12要求では各条件の同一process内2回で3形式全て一致。CPUとのbytes一致は要求しなかった。CPU/DX12のlossless PNG画素差はMAE 0.00007～0.00068 /255、PSNR 79.81～89.70 dBだった。この計測はbackend差でbytesが変わり得ることを示す。RAW ExportではCPU/DX12双方を許容し、同一checksumを約束しない。

NativeをExport中に終了した後、新processで原RAW再import・同じ完全settings復元・再生成したPentax JPEGも基準hashと一致した。これはisolated再生成の検証であり、製品Runtimeのclaim/recoveryやImmich duplicate uploadの実試験ではない。今回metadata noneなので時刻由来差はなく、既存Encoderのcanonical ICCも決定的だった。最終metadata付きartifactのtimestamp付きbyte決定性はRAWの必須条件ではない。

### 11.6 Preview・性能・リソース

既存製品が使うNative `render_preview` 契約1、After、quality full、stage_cache off、長辺1024を呼び、settings/crop/orientationを共通化した。原寸PNGをPillow LanczosでPreview寸法に縮小したものとの差（CPU）は以下。比較画像も隔離保存し、エージェントが画像として確認した。WebView2での色管理や利用者による実画面受入は未実施。

| 条件 | Preview寸法 | MAE /255 | PSNR dB | p99絶対差 /255 |
|---|---|---:|---:|---:|
| Pixel初期 | 1024×770 | 2.297 | 35.10 | 16 |
| Pixel代表 | 770×1024 | 2.920 | 32.97 | 21 |
| Pentax初期 | 1024×683 | 0.846 | 44.39 | 5 |
| Pentax代表 | 683×1024 | 1.448 | 39.78 | 9 |

画像確認ではcrop・向きと大きなWB/露光/Dehazeの傾向は対応するが、Previewの細部が滑らかで原寸縮小側のdetailが強い。Pixelは細部差が比較的大きい。RGB channel平均差の絶対最大は0.550/255だった。ただし平均が小さいことだけで局所トーン差を否定できず、厳密な「体系的差なし」の受入は残す。実装時にはPreview/fullのsource level・detail/denoise・resampler差を分けて評価する必要がある。DX12 Preview比較もほぼ同程度の数値だった。

時間はperf_counterの実測wall time。主反復の範囲、Native peakはWindows `GetProcessMemoryInfo.PeakWorkingSetSize`。20ms sampled working setも取得し、process全体のpeakと区別した。

| 素材・設定 | CPU JPEG s | CPU PNG s | DX12要求 JPEG s | DX12要求 PNG s | Native CPU peak MiB | Native DX12要求 peak MiB |
|---|---:|---:|---:|---:|---:|---:|
| Pixel初期 | 1.324～1.441 | 1.480～1.537 | 1.151～1.171 | 1.266～1.325 | 938.4 | 765.0 |
| Pixel代表 | 1.368～1.426 | 1.486～1.587 | 1.039～1.094 | 1.086～1.155 | 739.7 | 800.7 |
| Pentax初期 | 1.824～1.937 | 2.114～2.207 | 1.508～1.545 | 1.737～1.756 | 1446.1 | 1040.9 |
| Pentax代表 | 1.952～2.039 | 2.123～2.151 | 1.506～1.520 | 1.659～1.668 | 1035.0 | 881.0 |

これらはPreview常駐製品とは別processのExport Sessionで、bootstrap Previewと反復も含むprocess lifetime peak。独立した製品Preview processの常駐量を足した値ではない。GPU peak VRAM、実CPU使用率、renderer内部各stage時間は未測定。DX12 Exportにはper-job backend telemetryがなく、上表は「DX12要求／fallback報告なし」として読む。

Encoder測定はNative processとは別の新Python processで各条件1回ずつ行い、画像差分解析を含めなかった。

| 条件 | PNG decode/RGB化 s | 既存JPEG encode s | 合計 s | PoC process peak RSS MiB |
|---|---:|---:|---:|---:|
| Pixel初期 | 0.2913 | 0.0928 | 0.3841 | 226.2 |
| Pixel代表 | 0.1997 | 0.0647 | 0.2643 | 160.4 |
| Pentax初期 | 0.2817 | 0.1635 | 0.4451 | 344.6 |
| Pentax代表 | 0.1904 | 0.1102 | 0.3006 | 236.9 |

なお初回の全解像度NumPy差分解析を含むharnessではsampled PoC RSSが最大1572.8 MiBになった。後続の差分解析はrow chunkへ変更した。この解析用メモリをBackend JPEG encoder単体の必要量と取り違えない。製品ASGI Backendは起動していないため、その全体peakは未測定。

起動／Import／復元を分けるため、初期設定のPNG経路を追加で各1回計測した。合計は記載phaseの和で、startup、Import/select、bootstrap Preview、reset/merge/readback、原寸PNG Export、PNG decode＋既存Encoderを含む。事前hash確認、原本copy、比較解析、終了処理は含めない。

| 素材・mode | startup s | Import/select s | bootstrap Preview s | 復元/readback s | PNG Export s | 経路合計 s |
|---|---:|---:|---:|---:|---:|---:|
| Pixel CPU | 0.0493 | 0.0275 | 0.8953 | 0.0026 | 1.4745 | 2.8651 |
| Pentax CPU | 0.0304 | 0.0224 | 0.6016 | 0.0036 | 2.1471 | 3.3515 |
| Pixel DX12要求 | 0.0318 | 0.0274 | 2.2373 | 0.0026 | 1.2750 | 3.9934 |
| Pentax DX12要求 | 0.0337 | 0.0237 | 2.0347 | 0.0031 | 1.7815 | 4.3700 |

DX12は各Export時間が短くても、process初回のPreview/GPU準備を含む経路ではCPUより長かった。常駐cacheを含む実製品の応答時間やNAS性能へ一般化しない。一時成果物の単一最大はDX12 Pentax初期PNGの35,117,935 bytes（約33.49 MiB）。Base64だけで46,823,916 bytes（約44.65 MiB）になり、既存24 MiB応答上限は不足する。Pixel初期PNGも約17.29 MiBで既存17 MiB画像枠を超えた。

### 11.7 異常系・後処理・再現手順

| 異常系 | 実施と観測 |
|---|---|
| 不正DevelopSettings | PixelでWB tempを文字列にした要求を拒否。前後full settings一致 |
| readback不一致 | harnessで期待exposureだけを故意にずらし、不一致guardがExportを送らず成果物なし。Nativeが自然に不一致を返した試験ではない |
| 不正な出力先 | 隔離regular fileをparentに指定。Export失敗、targetなし、既存file不変 |
| 書込失敗 | 隔離directory自体を出力fileに指定。失敗、directory不変。権限変更やdisk fullは使わない |
| 不正Export要求 | quality101を拒否、成果物なし |
| 原本guard | コピー元ではなく隔離RAW copyへExportを試み、拒否とcopy hash不変を確認 |
| Native終了 | Pentax原寸Export送信50ms後にその子processだけ終了。要求失敗、final出力なし、隔離job folderに残存fileなし |
| 再生成 | 新processで原RAWcopyと同じ完全settingsから生成し、既存cold JPEG hashと一致 |

不正出力試験でも `*.tmp` 残存なし。これはwrite途中の全timingでのatomicity保証ではなく、実施したtimingと失敗条件の観測。partial画像を故意に製品へ渡す試験やOS枯渇試験は行っていない。新契約ではtemp/bytesを検証してからartifactとして公開する必要がある。

一時領域はrepository直下のGit ignore対象 `.tmp/raw-export-p0a/`。原本copy、PoC scripts、完全settings、計測JSON、生成画像を置いた。`results.json` は12成功Sessionの24組（CPU16、DX12要求8）のJPEG/PNG/既存Encoder JPEGのhash/サイズ/寸法/時間を記録し、`supplement.json` はmetadataと異常系、`phases.json` は追加phase測定、`summary.json` は集計を持つ。これらはGitへ追加しない。

再現はrepository Pythonで `prepare.py`（文書で確認した素材の存在確認・hashコピー・元DBはcopyだけ）、`poc.py`（probe）、`prepare.py`（Native hashでもRecipe照合）、`poc.py --run`、`supplement.py`、`encode_measure.py <pixel|pentax> <default|representative>`、`phases.py`、`summarize.py` の順。いずれもGit管理外の今回限りのharnessであり製品testではない。JSONはUTF-8として読む。Nativeの配列tool結果はstructuredContentがないためcontent textからJSONを読む。

比較受入用にCPU初回の原寸JPEG/PNG/既存Encoder JPEGとPreview比較画像、DX12初回の対応画像を隔離保持する。hash比較済みの重複反復画像、追加phase用画像、比較用metadata-all画像、不要なDBコピーは今回領域内だけで削除する。残すprivate JSONには入力対応情報があるため公開・添付せず、利用者の画像確認後にこのPoC領域を削除する。元素材・実DB・managed source/receiptには触れない。

実際の整理では今回領域内の84 file、770,404,454 bytesを削除し、約310.8 MiBを保持した。削除対象は解決済み絶対pathがPoC root内にある個別fileだけに限定した。整理後にも原本／copy／元DB hashとEXE attestationを再確認して一致、patch reverse-checkも成功した。

### 11.8 P0a時点の判断（後続決定で superseded）

当時は、製品Queueを変更する前に原寸lossless bytes＋標準metadata allowlist抽出のNative契約を実装・測定する案を進行条件に置いていた。2026-10-29の決定でこのNative契約は必須ではなくなった。LightCraftが既に生成するJPEGを使い、まずGenzoRoom側metadata-only経路を評価する。P0aの成功を根拠に既存Preview上限を外さないという判断は維持する。

1. **転送・資源上限候補（旧Native PNG案の試算）**：20,000,000 output pixels、各辺8192、PNG64 MiB、Base64 JSON line86 MiBなどはPNG/bytes転送案の未受入候補だった。現方針ではRAW実装の条件として適用しない。LightCraft JPEG file、EXIF/XMP処理、Preview共存を含むmemory/disk上限をP1で測定する。正当な画像を暗黙に縮小しない。
2. **時間上限候補（旧案）**：import60秒、restore/readback15秒、Export120秒、decode/validate/encode30秒、job全体180秒は現行受入値ではない。P1で通常RAWの長時間処理とCancel/timeout後cleanupを測り有限期限を決める。Stopのcurrent完了仕様は維持する。
3. **identityと生成結果**：sourceとfrozen settingsの所有関係、job/request ID、geometry/native寸法、sRGB/Full/After/SDR、output length/typeを検証する。execution backend/fallbackは診断情報として利用可能なら記録する。Engine tuple・output hashをRetry同一性やCPU/GPU選択固定に使わない。Previewの縮小画像やMCP active selectionを出力snapshotの代用にしない。
4. **metadata契約**：原RAW公開tagからOffset/Subsecの元文字列、Make/Model分離、露出bias/35mm焦点、GPS高度/日時などをtypedで抽出。missing/empty/invalid/unsupportedを区別し、既存validator/serializerへ渡す。MakerNoteや原TIFF blobを返さない。出力Softwareと永続timestampはGenzoRoom側の責任にする。
5. **隔離と再実行**：編集用live settings/Historyを変更しないjob/session境界、プロセス終了後の再import/full restoreを検証する。CPUとDX12を許容し、byte/hash一致を合格条件にしない。製品Retry/Recovery、mixed Queue、Immich duplicate/Album/Stack/COVERは後続段階で検証する。
6. **残る受入項目**：実保存Recipe fixture、非空の説明/DC配列・Unicode/レンズ仕様/GPS方向、複雑geometry・mask・denoise、より大きいRAW、WebView2での見た目。今回の2素材だけでこれらをPASSにしない。

Native JPEG marker muxはLightCraft追加patchがGenzoRoom方式より小さく、upstream更新の保守負担も軽いという根拠が得られた場合にだけ比較し直す。P0aのPNG→既存Encoder結果は過去の技術的事実として残し、RAW製品実装の必須条件から外す。

P0aでは製品コード・既存tests・patch・schema・README・CHANGELOGを変更していない。通常test suite/typecheck/buildは対象外とし、ここに列挙した実EXE隔離試験を実施した。最終文書は測定JSON・EXE/patch識別情報と照合し、`git diff --check` と変更対象確認を行う。Commit/PushはP0a当時の依頼条件であり、今回の作業履歴ではない。

## 12. RAW Export基本方針の確定（2026-10-29）

### 12.1 現行構成

RAWとJPEGは現像・JPEGエンコードを独立させ、出力管理から先を共有する。

```text
JPEG Asset → GenzoRoom JPEG Recipe v18現像 → GenzoRoom JPEG encoder ─┐
                                                                     ├→ ExportArtifact
RAW Asset → frozen RAW Recipe → LightCraft現像 + LightCraft JPEG encoder
         → EXIF/XMP metadata-only更新（JPEG圧縮データ保持） ──────────┘
  → 既存ExportRuntime / ImmichExportRegistrar
  → `-GenzoNN.jpg` / Immich tag・Favorite・Album・Stack/COVER
```

RAWの出力はJPEG・sRGB・ICC埋込・現像後フル解像度、LightCraft quality 95・4:4:4を当面固定する。Export時は`hdr:false`、`sharpen:none`、`metadata:none`、`addToPhotos:false`を指定し、HDR出力・resize・watermark・形式設定UIを追加しない。`longEdge:0`はLightCraft v0.14.0のExport APIで原寸指定としてP0a確認済み。JPEG bytes、量子化特性、見た目をGenzoRoom JPEG Exportと一致させない。完成JPEGをGenzoRoom Pillow encoderへ渡さず、marker-level metadata追加時もJPEG compressed scanを変更しない。

LightCraft現行MCP Exportは完成JPEGを指定fileへ同期書込し、画像bytesは返さない。Backend所有の隔離出力先で生成したJPEGを取得し、形式・寸法・ICC・4:4:4・上限を検証する案を第一候補にする。元RAWから許可した標準撮影情報を取得し、`Software=GenzoRoom`および必要なGenzoRoom XMP識別・出力日時・現像後寸法・Orientation=1・sRGB情報をmetadata-onlyで設定する。LightCraft標準JPEG metadataは正本とせず、元RAWにない値は推測しない。MakerNote、serial、vendor/private tagは無条件コピーしない。

### 12.2 metadata-only更新の実装判断

`jpeg_metadata.prepare_metadata()`は現在JPEG原本をPillowで読み、metadataを構成する。`create_export_artifact()`はさらにsource JPEGをdecodeしてvalidationし、最後に`jpeg_codec.encode_jpeg()`で再圧縮する。このartifact関数・encoderはRAWへ流用しない。初期実装はRAW専用builderとし、必要ならallowlist値のvalidator/serializerを小さく共通化し、JPEG経路のbytes/metadata仕様を維持する。

Pillow metadata serializerや既存依存を再利用できる場合でも、Pillowによる画像保存を経由して再エンコードしない。適切なmarker-only library/APIが既存にない場合は、JPEG segment/scan境界の厳密なparser・再構成が必要な実装量とテストを評価する。EXIF APP1/XMP APP1/ICC APP2の付与、既存marker置換、重複marker、長さ上限、不正JPEG、SOI/SOS/EOI、scan data中のstuffed bytes/restart markersを検証し、metadata前後のcompressed scan bytesを同一と確認する。RAW EXIF extractionとJPEG marker rewriteは別の安全境界として扱う。

LightCraft Native MUXは代替案に留める。GenzoRoom側metadata-only方式の実装が困難または依存負担が大きく、Native既存APIを拡張する方が変更範囲・upstream更新時の保守負担とも明らかに小さい根拠を得たときにのみ比較し直す。追加Native patch、Export bytes応答、巨大PNG/Base64 transportを初期設計の前提にしない。

### 12.3 Runtime・Retry・Immich責務境界

既存Asset Queue・管理画面・永続Export Runtimeの順序、保存状態、Start時のfrozen Recipe snapshot、単一worker、Stop（current完了後に後続release）、Retry（新run開始時点の最新保存Recipe）、再起動復旧を最大限共用する。RAW snapshot/validator/storeには形式variantが必要で、現行JPEG-only `frozen_recipe_json`/processing versionを曖昧に再利用しない。Recipe/Historyの内容・形式をRAW Exportが更新しない。Start後編集は現在runのsnapshotを変更しない。

RAWの再生成bytes・画素はRetry／再起動でも一致を要求しない。現在利用できるLightCraft versionでfrozen settingsを再実行できることを優先し、CPU・DX12を許容する。JPEG専用の厳密なduplicate recovery、timestamp/byte identity条件、engine pinningや新しい再現性契約は維持しない。通常のQueue failure/Stop/worker ownership、入力保護、登録結果の検証は共通基盤に従う。部分登録後に状態が不明な場合や番号が競合した場合の結果は現行`-GenzoNN` family検出、Immich duplicate response、registrar順に沿って実装前に整理し、重複Assetが生じることを許容する。新しいbyte一致契約やEngine固定で抑止しない。JPEG Retryの挙動は変更しない。

生成物は既存`ExportArtifact`形式に入れ、既存`ImmichExportRegistrar`へ渡す。GenzoRoom tag、source FavoriteのON/OFF、現在のAlbum union、Stack member保持、新COVER設定、最終非COVER Album正規化は再実装しない。RAWであることを理由に新Queue、Runtime、管理ページ、Immich書込経路を作らない。

RAWは現行でWindows LightCraft runtimeを持つが、JPEG Exportは共通Backend Dockerでも動く。初回RAW対応はWindows local renderer readiness時だけ有効とし、Dockerの既存JPEG経路・ports・deploymentを変更しない。RAWを含む旧Queue intentをDockerがどう安全に読み・解除・拒否するかをP2で確定する。現行lifespanのrecoveryとWindows manager初期化順は設計時の静的照合課題であり、起動順の変更範囲をP2で限定する。

### 12.4 旧P0a結果と製品要件の区分

§11は削除・改変せず、P0a時点の全観測値を保存する。Pixel/Pentaxの原寸、LightCraft sRGB ICC/4:4:4、CPU/DX12性能・メモリ、metadataの欠落・精度、Preview比較、原本/Recipe/Historyの保護確認は有効な技術検証結果である。

一方、PNG→GenzoRoom encoderは**技術的に成立したが製品方式として不採用**。PNG/Base64転送サイズ、existing `RenderedImage`/encoder共用、CPU固定、CPU内のcold/warm SHA-256一致はRAW Export実装の必須条件ではない。P0aのLightCraft JPEGとGenzoJPEGの比較・hashは測定記録であり、現在のLightCraft JPEGを強制する仕様でない。再生成hash一致やCPU/DX12相互一致を要求しない。Native patch必須化を導いた旧P0b判定は本節の設計で置き換えた。

### 12.5 Phase計画・残る確認

1. **P1：LightCraft JPEG／RAW metadata／Artifact** — 現行Export APIを利用し、隔離JPEG生成、metadata extraction/marker-only付与、形式検証、専用Artifact builder、`-GenzoNN.jpg`を完成する。Pixel/Pentax PoCでscan不変・metadata・原本保護・容量/timeout/cleanupを確認する。Native patchは不可避性が根拠付きで判明した場合だけ再評価。
2. **P2：既存Queue／Runtime** — frozen RAW Recipe variant、DB互換migration、Queue適格性、Start/Stop/Retry/restart、Windows lifecycle、DockerでのJPEG互換とRAW safe refusalを統合。
3. **P3：Frontend Queue／管理** — RAW Queue操作・保存drain・Stack候補・status/Retryを既存画面に統合し、既存選択/armed/Retry優先との整合を検証。
4. **P4：受入・監査** — Pixel/Pentax実機・Recipe restore・Preview比較、混在Queue、実Immich Favorite/tag/Album/Stack/COVER、partial failure・Retry・再起動を利用者環境で確認。生Album membershipを検査。

追加で調べる項目は、複数RAW形式からの安全な標準tag extraction、既存serializer/依存でmarker-only追加を実現する最小法、LightCraft JPEGの品質/ICC/SOF検証方法、large-output・disk failure時cleanup、Recipe restore後のPreview/Export条件、partial Immich result後の連番競合である。実保存Recipe fixtureと実機WebView2の見た目・Immich統合はP4受入まで未確認。Source static inspectionだけでの確定と実RAW／Immich PoCでの確認を混同しない。

## 13. P1実装・検証結果（2026-10-29）

> 本節はP1初回時点の記録。TIFF/DNG限定・非TIFF拒否は実装時の暫定制約であり製品方針ではない。後続の§14で撤廃した。

**総合判定：P1の独立Artifact経路は実装・Pixel/Pentax隔離検証完了。実保存RecipeおよびWindows目視、Immich実機受入は未実施。** 開始HEADは`cd6a150770774ceb0d6b7f26c63d16022b686211`、作業ツリーclean。manifest v0.14.0/commit、適用patch reverse-check、EXE SHA-256とreceiptは§11.1と同一で整合。Native source・patch・binaryは変更・再buildしていない。

### 13.1 実装判断とP2契約

新`backend/raw_export_artifact.py`の`RawExportInput`はsource bytes、source_filename、callerが取得したfamily_filenames、保存済みの完全DevelopSettings、timezone-aware timestampを受ける。`await export_raw_artifact(request, manager=..., temp_root=...)`が`ExportArtifact(filename,jpeg)`を返す。`manager`を渡す場合はそのGPU policyを引き継いだ独立Managerを既存clone機構で生成し、渡した編集Managerの状態には触らない。省略時も既存Windows管理Engine解決を利用しDX12 policyを使う。Engine tupleは安全な実行binaryのattestation用途であり、Recipeの旧Engineに固定する契約ではない。

P2側の責務は保存Recipe/snapshot選択、source identity照合、Queue/Runtime/失敗codeとの接続。P1はDB、saved Recipe/History、Frontend、Immichへアクセスしない。settingsを最初のawait前に複製し、Native reset/merge/get一致後、`metadata:none`の既存JPEG Exportを行う。Export後もsettings一致を確認する。Native PhotoIdはこの呼出内だけの値。独立Sessionはlive選択・settings・Undoの変更を回避するため採用した。source copyとoutputをjob専用tempに置き、close/reap後にdirectoryをcleanupする。既存Managerの終了処理を再利用し、失敗・取消でも後処理する。各Native call120秒、ready待ち20秒を初期有限期限とする。

既存依存にはPillowのmetadata serializerと既存JPEGのallowlist/parserがあるが、既存JPEG Artifactはencoderを呼ぶため使用不可。追加依存を入れず、新RAW builderでEXIF/XMP APP1だけを置換する方法を採った。Pillowの画像保存は使用しない。`create_raw_export_artifact(source,jpeg,source_filename,family_filenames,timestamp=...)`は完成済みLightCraft JPEGを受け、既存`next_export_filename()`で命名する同期境界。`RenderedImage`/`JpegRenderer`/`encode_jpeg()`は一切呼ばない。EXIF/XMP以外のmarker、ICC、coding tables、scan/entropyをそのままコピーする。元にEXIF/XMPがあれば置換し、重複APP1を作らない。Native baseline single scan以外や壊れたJPEGは拒否する。

RAW metadataはclassic TIFF/DNG IFD0/EXIF/GPSと埋込標準XMPのみ。入力512 MiB、IFD16個・各4096entry、tag payload65,504 bytes、settings256 KiB、JPEG256 MiB・100 MPの初期ガードを置いた。strip/SubIFDの画素やMakerNoteには進まない。非TIFF RAW（CR3/RAF等）は`raw_export_unsupported_metadata_container`で明示拒否し、対応済みと表示しない。壊れたIFD構造は失敗、optional標準値は既存validatorの範囲でdropする。EXIF/XMP aggregate上限・標準text/GPS検証も既存JPEG実装を変更せず利用する。

### 13.2 自動テスト・実RAW

repository Python 3.14で`tests/test_raw_export_artifact.py tests/test_export_artifact.py tests/test_jpeg_codec.py`を実行：**47 passed、68 subtests passed**。metadata置換の冪等性、coded scan/ICC保持、原情報/識別情報、malformed JPEG/TIFF・循環IFD、timestamp、XMP/private除外、正常・復元不一致・Native失敗・取消のtemp cleanup、settings不変を確認。既存JPEG関連テストも同じ最終コード状態で成功。sandboxのpytest temp作成エラーは同一コマンドの権限付き実行で解消。Frontend/build/full suiteは変更範囲外。

P0aの隔離copyと保存済み人工代表settingsを使い、新Artifact APIから生成した。今回の4条件はいずれもDX12 policyで実行し、CPU固定していない。現在のWindows設定・binaryで成功した事実であって全GPU/全RAWの保証ではない。

| 条件 | SOF実寸法 | 完成JPEG bytes | 復号・sRGB ICC・4:4:4・GenzoRoom識別 |
|---|---|---:|---|
| Pixel初期 | 4064×3056 | 4,430,085 | PASS |
| Pixel代表crop/Rotate90 | 2445×3251 | 3,236,547 | PASS |
| Pentax初期 | 5472×3648 | 10,181,973 | PASS |
| Pentax代表crop/Rotate90 | 2918×4378 | 7,082,587 | PASS |

全4条件でP0aの同一DX12/source/settingsによるLightCraft JPEGと、EXIF/XMP以外の全segment・coding tables・ICC・scan bytesが一致した。これに加えてbuilder単体テストでmetadata付与前後の同じ入力に対するcoded-data不変を確認した。これは同一生成物のmetadata処理が画像を変えない検証であり、Retry時の再生成一致要件ではない。quality95は固定要求・Native source経路で確認し、JPEG内の架空のquality tagには依存しない。全完成JPEGをPillowでloadして復号可能と確認したが、Immichへのupload/readbackは行っていない。

Pixelはroot標準2項目、capture16項目、GPS8項目、Pentaxはroot2/capture13/GPS0を取得してoutputと比較した。Make/Model、LensModel等の存在tag、PixelのOffsetTimeOriginal/SubsecTimeOriginal原文字列・GPS高度/時刻・露出bias/35mm焦点を保存する。Pentaxの標準GPS等の不在は補完しない。§11.4の元tag不在一覧は有効。非空LensSpecification/著作権/GPS方向はsynthetic testで補い、fixtureにない情報の実RAW受入と混同しない。既存validatorで非ASCII EXIF textはdropされ、Unicodeは標準XMP経路で扱う。

原本SHA-256はP0a baselineと一致、source bytes/settingsも不変。SQLiteや保存APIを呼ぶコードはなくRecipe/History書込を行っていない。生成JPEGとprivate検証script/summaryはGit ignore対象`.tmp/raw-export-p1*`にのみ置き、個人metadata・画像・原本pathはcommitしない。

### 13.3 残存事項

実保存Recipeが今回2素材に対応していないため人工settingsで復元を確認した。利用者のWindows/WebView2でPreviewと最終JPEGの目視比較は未受入。P0aのPreview比較は有効だが今回の実画面確認ではない。TIFF/DNG以外のRAW metadata、悪意ある入力へのさらなる形式別coverage、live Preview同居時の合計資源・大画像・disk full・実OOM/driver lossは未確認。Immich読込・mixed Queue・Stack/Album/COVER・Retry再起動はP2以降。P1はRuntime等へ接続せず、今のJPEG Export仕様も変更していない。

## 14. P1追加修正：形式制限撤廃（2026-10-29）

RAW Exportは利用中のLightCraftが読み込める形式を基本的に受け入れる。TIFF/DNG限定はP1初期実装の暫定制約であり、現在の製品方針ではない。ARW/PEF/NEF/CR2/CR3等を拡張子の推測リストで許可・拒否しない。Native import/develop/exportで読めない入力は通常の処理失敗となる。

元Asset名は両OSのpath separatorを除いたbasenameへ正規化し、危険文字・Windows device名を無害化、stemを128文字に制限して拡張子の綴り・大小文字を保持する。job専用directory内の`input/`へcopyし、output JPEGとは別directoryに置く。これにより`source.dng`固定を撤廃し、原名が`output.jpg`でも出力と衝突しない。原本pathへの書込は行わない。

標準撮影metadataはoptional。TIFF headerには既存bounded TIFF抽出を使い、他containerはPillowのheader読取で取得可能なEXIF/XMPを既存allowlistへ渡す。画素loadや再エンコードはしない。非対応container・壊れたoptional metadataは`export.metadata_unavailable`／`raw_export_metadata_unavailable`警告を記録して空metadataへfallbackする。元にない撮影情報は作らず、完成JPEGにはGenzoRoom識別、出力日時、Orientation=1、現像後寸法、sRGB情報を必ず付与する。空入力・過大入力等のsource validationとLightCraft decode失敗は別で、前者は`raw_export_invalid_source`、import tool失敗は`raw_export_source_unreadable`、その他Native tool失敗は`raw_export_native_failed`。Native metadata support不足だけでは出力を拒否しない。

既存API調査：managed `crates/engine/src/cmd/query.rs`の`photo.inspect`はcatalog Photoのserializeであり、完全な元EXIF getterではない。`export.rs:export_metadata`もcatalog subsetを使用し、GPS高度はNone、camera→model、capture timeは日時正規化後。P0aの情報欠落・精度変化が残るため、Make分離や元のsubsecond等をここから推測しない。Pillowで取得できない標準情報は欠落を許容する。今回、catalogからの部分補完やNative patchは追加しない。

検証：関連61 tests＋既存68 subtestsが成功。非TIFFのNative mock成功、元拡張子保持（ARW/PEF/NEF/CR2/CR3/未知拡張子）、path安全化、metadataなしの識別情報、Native import失敗、TIFF構造不正時fallback、JPEG scan/tables/ICC保持、cleanup、source/settings不変と既存JPEG回帰を確認した。mockは各camera形式のdecode成功の証明ではない。

実RAW回帰は既存Pixel/Pentax DNGで初期4064×3056／5472×3648、代表crop/rotation2445×3251／2918×4378の4条件を再生成。全件で復号、識別、sRGB ICC、4:4:4、取得標準tag一致、P0a Native参照とのscan/tables/ICC不変を確認。原本hashも不変。ARW/PEF/NEF/CR2/CR3の実素材受入は未実施であり、実機検証項目として残す。Recipe/History/SQLite、Queue/Runtime/Frontend/Immich登録に変更なし。


## 15. P1監査Finding限定修正（2026-10-29）

F1/F2を解消：公開create_raw_export_artifactが未検証JPEGを一度解析する責任を持ち、Native応答寸法も同じSOF情報と比較する。SOF0/SOF1/SOF2の8bit・3 component・4:4:4を扱い、Baseline/単一scan限定を撤廃。scan間metadataを含め全marker位置の標準EXIF/XMP APP1を置換する。marker長・境界・scan終端・EOIは検査するが、Huffman/量子化表やentropyの意味を解釈するデコーダーは作らない。全JPEG反復走査をなくし、byte-rangeとmemoryviewから一度joinする。圧縮scan・tables・ICCを変更せず再エンコードもしない。検証済み入力を仮定する抜け道は公開builderに追加しない。

F3を解消：edit_store._json（ensure_ascii=False、sort_keys、compact separators、非有限値拒否）とraw_recipe_store.MAX_SETTINGS_BYTESを用いる。256KiBは維持し、Unicode/空白/escape表現差で保存可能RecipeをExportだけが拒否する問題を除去した。独自validatorやschemaは追加しない。P2での保存snapshot選択・保存validationという責務は維持する。

F5を解消：通常の許可リスト継承を維持。EXIFまたはXMPの合計がAPP1上限を超えたときだけ、export.metadata_reducedのwarn（metadata_too_large、本文や値はログしない）を記録し、任意の継承情報を落として両packetを最小構成で再生成する。Software/CreatorTool=GenzoRoom、UTC output date、Orientation=1、SOF寸法、ColorSpace=1は保持する。文字列切断はしない。最小構成の生成自体が失敗すればArtifact失敗となる。

F6を解消：ICC存在・chunk連番/構造・読取可能性・RGB profile・保持を検査し、description文字列は検査しない。sRGBはNative Exportへの明示要求と更新時の互換性検証で確認する。名称で色空間の意味を断定しない。

F4：100MPを製品拒否条件から撤廃。JPEG header解析はPillow Image.open/loadを使用せず、JPEGのSOFから寸法を読む。Pillow画像の既定大画像判定を全体無効化する変更は行わない。100MP超のsynthetic SOF（20000×20000）を画素decodeなしに検査できることを確認した。これは400MP実画像の描画/復号やmemory安全性の実測ではない。RAW512MiB、JPEG256MiB（metadata追加後も含む）、ICC1MiB、Recipe256KiB、APP1等の既存上限は維持。

検証：新RAW＋既存JPEG artifact/codec対象で79 passed、既存68 subtests passed。Baseline、Pillow生成Progressiveの複数scan、scan間APP1、APP1有無/重複置換、marker長・途中切れ、no decode/re-encode、圧縮データ/tables/ICC保持、renameしたRGB ICC、EXIF/XMP各単独/両方超過fallback、UTF-8 Recipe256KiBちょうど/超過、非JSON/非有限値を確認。公開builder呼出で解析回数が1回であることをtestで確認。通常sandboxのpytest temp権限問題は同一interpreterの権限付き実行で解消。

Pixel/Pentaxは隔離入力copy・人工代表settings・既存managed EXEを使用。初期4064×3056/5472×3648、crop/Rotate90代表2445×3251/2918×4378の4条件を再生成し、metadata識別・元標準tag・画像復号・P0a同条件Native参照のscan/tables/ICC一致を再確認。原本SHA-256も一致。Recipe/History/SQLiteへの書込なし。実保存RecipeとWebView2受入、ARW/PEF/NEF/CR2/CR3実素材、Immich/Queue連携は未確認。Progressive/複数scanはfixtureの試験であり、現行LightCraftがそれを生成したとは扱わない。

独立Manager/Session、現行finite timeout、前後readback、metadata抽出方式、JPEG Export、Queue/Runtime/Frontend/Immich、Native patchは今回変更しない。serializer共通化とSession再利用も追加しない。§13等のBaseline/単一scan・100MP記述は旧P1時点の履歴であり、本節を現行仕様とする。


## 16. P2実装：既存Queue／Runtime接続（2026-10-29）

### 16.1 保存選択・snapshot・既存データ互換

既存Queue/APIを拡張し、JPEG保存Recipeに加えて保存済みRAWを投入可能にした。raw_recipe_store.select_raw_export_stateはRAW Edited Badgeと共通でupdated_at降順→recipe_revision降順の最新rowを選択し、verified importDefaultsFingerprint、旧rowはHistory baselineでcurrent設定を比較する。判定trueだけ適格。Historyの長さだけでは適格にしない。RAW rowがあれば同Assetの旧JPEG-preview Recipeより優先し、RAW default/unknownをJPEGとして出力しない。現行Engine tupleとの完全一致や拡張子リストは要求しない。

edit_store._export_saved_state/_export_eligibleをenqueue、Start、Retryで共有。enqueueはintentだけ、StartはBEGIN IMMEDIATE内で全対象の最新保存revision・Recipe/settings・source identity・設定schemaを固定しwaitingへ遷移する。Start後の保存・Reset/History削除はactive itemを変えない。既存JPEG保存/Queue非干渉契約を保つため、RAW保存/Reset APIからQueueを削除しない。RAW defaultや保存消失後もmutable intentは残るが、新Start/Retryは拒否し、既存dequeue操作で解除できる。§6の自動mutable cleanup案はP2では採用しなかった。

schema追加なし。既存export_run_items.processing_version=raw-lightcraft-v1を明示discriminatorにし、recipe_versionへRAW settingsSchemaVersion、frozen_recipe_jsonへfull RAW Recipeを保存する。既存JPEGは従来と同じrecipe v18/processing version/payload。読み出しでRAW validator、schema、Asset IDを検査し、未知・破損payloadは既存StoreUnavailableとして停止。RAW識別子はGenzoRoomのsnapshot契約であってNative engine pinではない。旧binaryはRAW runを解釈できないため旧JPEG validatorで安全に拒否する。既存JPEG-only runの再開形式は変えない。

### 16.2 Runtime・P1・Registrar

既存ExportRuntime._process_itemがsnapshot.kindに従い、JPEGは現decoder/renderer/encoder/_artifact、RAWはRawExportInputとexport_raw_artifactへ分岐。sourceのAsset IDとis_rawを照合し、拡張子では拒否しない。原本取得・family検索・encoding/registering遷移・成功時Queue削除は既存のまま。RAWで返ったExportArtifactは同じImmichExportRegistrarへ渡し、upload/Favorite/tag/Album union/Stack member保持/COVER/非COVER cleanupを再実装しない。raw_artifact依存はテストで注入でき、production既定はP1関数。

P1にはoptional expected_content_hashを追加し、import後の既存photo.inspectでNative source hashを照合してからsettingsを適用する。原本と保存Recipeの対応を保つための入力identity検査であり、Engine version/commitや再生成JPEGのchecksum固定とは別。現像/metadata/encoding設計はP1のまま。kindまたは入力hash不一致はsource_kind_mismatch、通常RAW失敗は既存encoding_failed等により当該itemだけfailedとし後続を続行する。DB/ownership障害は既存どおりactiveを保持してworkerを停止する。

P1はjob内で独立Managerを起動し、元RAW/Recipe/Historyの保存APIを呼ばずclose/reap/cleanupする。このため既存lifespan recoveryが編集Manager起動前でも、RAW Exportが編集Managerのreadyを待つ構造にはしない。Native未配置の環境ではRAW itemが通常失敗し後続JPEGは継続できる。DockerにNative依存・port・build変更は追加しない。

### 16.3 Stop・Retry・recovery

Stopはcurrent RAW処理・登録を完了した後にwaiting suffixをqueued/releasedへ戻す。強制Native cancelへ置換しない。Retryはfailed intentを既存transactionでqueuedへ戻し、新Startでその時点の保存RAWを固定する。RAWはJPEGのregistration_failed timestamp identity検索を通さず、新run timestampを使う。JPEGの同一snapshot時timestamp再利用とduplicate収束保証は維持。

再起動は既存claim/reclaimとworker UUIDを使い、encoding/registeringをwaitingへ戻し、固定RAW Recipeを現行engineへ再適用して登録を先頭から行う。生成JPEGが変わることや重複Assetを許容する。source原本の対応、正常なartifact、remote結果の整合検証は維持する。新Queue、Runtime、remote checkpoint、重複防止永続機構、CPU固定、Native patchは追加しない。

### 16.4 検証・監査・残存事項

横断テスト：P2/既存Queue/Runtime/Stop/Retry/recovery/RAW Recipe・History/既存Registrar/Album/P1 Artifact/JPEG codecの12 filesで527 passed、既存68 subtests passed。最終監査の入力hash照合とhelper整形後は変更影響のP2/P1/RAW Recipe計152 casesが成功。テストは既存fixture、隔離SQLite、Native mock、既存Registrar＋mock HTTP transportを使用した。保存適格性、API投入、混在atomicity、Start時最新状態、Start後編集、RAW失敗後継続、Stop、最新RAW Retry・異なるJPEG bytesの受入、live Reset後recovery、旧Recipe engine tuple、Favorite ON/OFF/tag/Album/Stack/COVERを確認。

監査修正：初期のRAW default/Reset cleanup案はJPEG Queue非干渉回帰を起こしたため削除。新default判定testのint/float fixture差、AssetDetail model copy、Remote既存date契約を修正し実装障害と分離した。原本hashとRecipeの対応検査が抜けないようP1の任意入力照合を追加した。High/Mediumの既知未修正Findingは残していない。P1再設計・Registrar複製・schema migrationは行っていない。

実RAW/Windows Native/実ImmichのP2連携は未実施。P1以前のPixel/Pentax成功をP2実機成功と扱わない。FrontendのRAW Q操作・保存drain・管理画面統合はP3、mixed Queueの実Immich/Album生membership/Stack/COVER・再起動受入はP4。保存rowが同一updated_at/revisionで複数ある場合の順序は既存badgeと共通のままで、新しいengine選択や独自tie制約を導入していない。README/CHANGELOGは今回更新しない。
