# GenzoRoom / LightCraft v0.20.0 接続境界・依存度監査

監査日：2026-11-12（Asia/Tokyo）。基準：`feature/lightcraft-v020-port` / `40a84cd`（P4-B完了）。作業開始時のworking treeはclean。本監査は実装変更を行わない。

## 1. 総合評価

**現行統合は、エンジン全体を過剰に所有する構造から、標準Engineを利用する構造へ改善している。ただし、settingsの予測検証とGeometry metadataには重要な内部依存が残る。**

- デコード、現像、WB推定、曲線演算、画像生成はLightCraftに委ねている。Whole／Regionは標準`render_job`／`region_job`を実行する。旧StagePool、allocation計量、GPU実行結果をPreview成功条件にする仕組みは現行managed patchに含まれない。
- 残る過剰依存の中心は、GenzoRoomがNative Resetの結果をフィールド単位で再構築して全体一致を要求すること、Native snapshotへ既定値を補完すること、Curveの全キーを固定すること。`optics.lens_profile`の実障害と、下記H1の`nr_outliers`が具体例である。
- Native patchはMCPへの必要な橋渡しを多く含むが、`Rendered.frame`の伝播とGeometry descriptor生成は内部実装依存である。これを「公開APIのみ」と呼ぶのは不正確。ただし現時点で同じ表示機能を保てる標準MCPの代替は確認できず、即時削除は勧めない。
- 移行が重くなった原因は、upstreamの変更だけではない。旧内部契約を移植する作業を実施した後、所有境界を見直して新しい最小接続へ切り替えたため、**旧拡張の追従と設計変更の双方のコスト**が発生した。人時の記録がないため、原因別の割合は算定しない。
- 次回更新はStageCache／GPU内部への追従が不要になった分、軽くなる見込み。ただしReset検証、snapshot復元、Frame構造変更は引き続き追従点になる。

**判断：大規模な再設計のためにP4-Cを止める必要はない。ただしH1のRAW Detail Reset／省略false復元を、P4-Cの広い受入確認より先に対象を絞って修正・確認すべきである。P5のExport／Thumbnail受入にも同じ復元問題を持ち越さない。** 本監査では修正もP4-C／P5の実施も行わない。

## 2. 根拠・調査範囲

`AGENTS.md`、`docs/architecture.md`、恒久統合契約、移植計画、更新ガイド、active manifest、現行／旧managed patch、Backend／Frontendの該当接続、関連テスト、Git履歴を照合した。移植計画冒頭の正式改訂を現行方針とし、後半の旧P0〜P12／N工程を現行要件とは扱わない。

ソース参照の表記：リポジトリ内は`path:行番号`（基準Commitの行）。Nativeは固定upstream `192ff72923c39e6623f2c7ff67ab3a119deb8071`。`N:`は、そのHEADを確認したローカル`.tmp/lightcraft-0.20.0-p3/`のpatch適用後ソースを表す。永続的な拡張根拠は`native/lightcraft/patches/0001-v0.20.0-whole-frame.patch`（以下`P:`）の行番号も併記する。固定upstream自身は同checkoutの`git show HEAD:<path>`で区別した。

旧版は`.tmp/lightcraft-0.18.1`のHEAD=`57024f072c234e0c6c850e0940a261790f976575`を確認し、必要箇所を`git show HEAD:<path>`で参照した。新checkoutでの旧新commit間diffは旧object不足で失敗したため、取得／Fetchせず、それぞれの固定HEADのソースとGenzoRoomの履歴・patchを比較した。ユーザーのRAW原本、DB、Immichにはアクセス・変更していない。

「確認」はソース／履歴または本監査の局所確認による事実、「推定」「要確認」は未実証の将来リスクを示す。既存文書の実Native検証実績は過去の記録であり、本監査で再実行した結果ではない。

## 3. 依存関係一覧

A＝標準公開Engine／MCP、B＝アダプター、C＝内部仕様の再現・推測、D＝内部実装への介入。独自MCP契約は、GenzoRoomから見て公開されていても自動的にAとは分類しない。

| 接続・対象コード | 分類 | 依存内容・必要性・代替 |
|---|---|---|
| `backend/lightcraft_raw.py:1544`、`:1655` | A/B | 数値編集は`develop.set`、Optics等は`develop.merge`、Curveは`develop.curve`／`curve.reset`。IDとJSON field名の対応は`raw_controls.py:58`。UIの許可入力・範囲検証は維持する。 |
| `backend/lightcraft_raw.py:302`、`raw_controls.py:89` | C | WB scale、Crop、orientation、Grading、Optics、Curveの省略を補う。未知のtop-level fieldは概ね保持するが、Native readbackそのものの無加工保存ではない。M1。 |
| `backend/raw_controls.py:122`、`raw_recipe_store.py:116` | C | `set(curve) == CURVE_SETTING_FIELDS`で新しいCurveキーを保存・復元前に拒否する。既知フィールドの型検証とunknown保持を分離できる。M1。 |
| `backend/raw_geometry.py:26` | B/C | Cropの型・範囲とorientationを検証。Crop／geometry／rectのキー完全一致はNativeの構造拡張へ追従を必要にする。入力operationの閉じたallowlistとは区別する。 |
| `backend/lightcraft_raw.py:1447`、`:1829`、`:1850` | A/B＋C | reset→merge→getでRecipe／Historyを復元し、正規化後のJSON文字列を完全比較。写真・revision所有の検証はB。省略snapshotをpartial mergeで復元できるという仮定はC。H1。 |
| `backend/lightcraft_raw.py:1686`、`:1720`、`:1781` | B/C | As Shot／bypass保持はアプリ操作の意味。Reset既定値や変更しない全fieldの予測はC。H1／M2。 |
| `backend/raw_export_artifact.py:324`、`:380` | A/B＋C | 独立Nativeで標準Export。settings補完・reset→merge・前後比較は編集sessionと別実装。M3。 |
| `backend/raw_geometry.py:92`、`lightcraft_raw.py:1561` | A/B | `crop.*`と`photo.rotate*`／`photo.flip*`へ意図を送信しreadbackを採用。画像のCrop／Straighten fittingをBackendで実装していない。 |
| `frontend/src/rawCropMath.ts:41`、`rawStraightenTool.ts:3` | B | Crop枠の表示投影、viewport行列、基準線から角度を求めるUI処理。画像resamplingやNativeの確定crop fittingではない。維持。 |
| `frontend/src/rawCropDisplay.ts:23`、`:44` | C（UI限定） | 暫定aspect、Moveの最近傍実行可能offset、回転境界への制約を再現。確定settingsはNativeであり、UI追従のための依存。M5。 |
| `frontend/src/rawTargetCoordinates.ts:10`、`ImageViewer.tsx:233`、`:590` | B／一部Cリスク | Crop／Flip／Straightenを戻し、WBとCurveのoriented-source座標へ接続。必要なAPI座標変換だが、実Frameと保存cropが一致する前提、Warp非対応は要確認。M5。 |
| `frontend/src/rawWholePreview.ts:8`、`rawRegionPlanner.ts:34`、`rawRegionSchedule.ts:37` | B | DPR、Zoom、Panから表示に必要な解像度・windowを決定、pendingを置換。EngineのRender PlanやGPU buffer予算ではない。維持。 |
| `backend/lightcraft_raw.py:592`、`:1905`、`:2001`、`:2047` | B | revision／generation／kind／interactionによる要求集約・取消・stale排除。実行中処理をjoinしreadbackする責務を維持。 |
| `backend/lightcraft_runtime.py:674`、`:697`、`raw_region.py:91` | B | Native wireへの変換、PNG・window・応答identity検証。BackendとFrontendの検証は異なる信頼境界。単純統合しない。 |
| `P:225`、`:287` | A/B＋C | Wholeは標準job、Regionは標準region job。Region plan用Frame構築は内部Geometry準備への依存が残る。M4。 |
| `P:403`、`:425`、`:893` | C/D | crop量子化、Warp／lens構造の列挙、原本寸法への投影でGeometry ID／寸法を生成。標準MCPに同じmetadataはない。M4。 |
| `P:186`、`:906` | D | CPU／GPU内部のrender結果へFrameを追加し各constructorを修正。GPU制御ではないが内部結果型への直接結合。M4。 |
| `P:21`、`:681`、`:800`付近 | A/B＋D | read-only WB候補を公開。標準`auto_wb`を利用するが、EngineのSession／Thumb取得・wbPick実装を変更する。確認／cancelを維持するには即時変更型wbPickだけでは不足。 |
| `backend/lightcraft_raw.py:829`、`lightcraft_runtime.py:75`、`:526` | A/B | 標準`app.memoryBudget`、環境のGPU backend選択、`app.gpu`照会は残存。StageCache slot／allocation／fallbackの内部操作とは異なる。 |

## 4. settings・Recipe・編集操作のFinding

### H1 — High：RAW Detail Resetの予測検証と省略false復元

**確認済みのコード不整合：** Native `DevelopSettings::for_raw`は`nr_outliers=true`（`N:crates/develop/src/lib.rs:24`）。Detail Resetはfalseへ変更（同`:179`、`:192`）し、falseはserdeで省略する（`N:crates/develop/src/settings.rs:649`）。一方GenzoRoomのDetail Reset検証は操作前settingsをコピーし、`DETAIL_RESET_DEFAULTS`のみ更新するためtrueが残る（`backend/raw_controls.py:76`、`lightcraft_raw.py:1781`）。正常なNative応答を`:1795`の全体比較で失敗にする。

これは旧Recipe互換性の話に限定されない。現行RAWの初期状態でもtrueが入る。失敗するとcompound rollbackが走る（`:1523`）ため、DB破損を確認したというFindingではなく、**正しい編集を確定できない**問題である。後述のメモリ内確認でも、実際の検証closureがNative仕様どおりの省略falseを`raw_operation_readback_mismatch`として拒否した。実RAW＋HTTPによる本監査での再現ではない。

関連して、falseを含む完全snapshotが保存されると省略表現になる。`_restore`はRAW import defaultへresetし、partial mergeするため、未指定のfalseはtrueに戻る。同tupleのUndo／Redo／再Open、Thumbnailの共通復元、独立Exportのreset→mergeにも同じ条件がある。P4-Bのidentity一致は**世代選択**を解決するが、この**同世代内の省略表現**を解決しない。

Native自身は`to_json_for_merge()`でfalseを明示している（`N:crates/develop/src/lib.rs:42`）。しかし現在の`get_develop`をそのまま保存する接続でこの関数を利用しているわけではなく、Rustの公開helperが存在することを標準MCPの完全snapshot置換APIが存在することと混同しない。

推奨：対象fieldのsnapshot送信・readback比較とDetail Reset検証を最小範囲で合わせる。通常の部分更新へfalse補完を適用しない。DB保存形式、既存receipt、fingerprintの正本、P4-Bの完全identity一致／非互換初期値起動／旧Recipe保持は維持する。標準APIのまま修正可能で、Native patch追加は不要。全面的な設定正規化frameworkは不要。

#### H1修正済み（2026-11-12）

`raw_controls.complete_snapshot_for_merge`が完全snapshotだけへfalseを明示し、readback比較用helperはNativeの省略falseを同値として扱う。編集snapshot、persisted Recipe、History rollback／Undo／Redo／Jump／Thumbnailは共通`_restore`を通る。Exportも独立processのまま同じwire変換とcomparison semanticsを使う。Recipe／History保存本文、receipt、fingerprintは変換せず、部分`develop.merge`経路にも適用しない。Detail ResetではNative readbackの省略／falseを受け入れ、trueや他settingsの差分は従来どおり全体比較で拒否する。既存Findingの根拠は維持し、修正記録として追記する。

Backend focused testsは65件成功（raw_controls snapshot helper、RawSession restore／Detail Reset、Recipe restore、Export artifact）。失敗rollbackと既存 Export settings検証を含む。Receipt付きLightCraft v0.20.0の実EXE（`target-p3-wb`）で、リポジトリJPEGの一時コピーを使いDetail Reset、partial merge、false省略／明示true snapshotの往復を1件確認。実Native EXEのbuild.py identity／SHA/schema probeも成功。本監査・修正ではRAW実素材がないため、RAW import true、Pixel／Pentax DNG、実NativeでのRAW初期値reset、Windows実RAWの画像種別差、実Native Thumbnail／独立Export、ユーザーDB上の既存tuple再Openは未確認。合成DNGによるBackendテストは実DNG検証ではない。

**先行理由：** RAWで正当なResetを拒否し、false状態の保存復元にも波及する具体的な接続不整合である。広いP4-C回帰を先に回しても同じ失敗が複数経路に出るため、P4-Cの受入本走行より前にこの境界だけを修正・局所検証する価値がある。P4-C計画を全面停止して別の大規模改修を行う理由はない。P5へは修正と関連復元確認を済ませてから進む。

#### H1 P4-C追確認（2026-11-12）

P4-Cの実Native HTTPテストで、JPEG／Pixel DNG／Pentax DNG各1件をreceipt検証済みv0.20.0 Nativeと一時DBで実行した。RAW素材は`I:\code\raw-test`のPixel／Pentax DNGを一時コピーし、原本は読み取りのみ。3素材すべてで複数カテゴリRecipeの保存・Document破棄・再Open後にNative settings一致を確認した。RAWではImport `nr_outliers=true`→Detail category reset後のfalse相当readback→false省略Recipe再Openまで成立し、その後のallResetはNative Import baselineのtrueへ戻ることも確認した。WB／Optics／`disabled_sections`の既存Reset意味論を維持した。

これによりH1で残していたPixel／Pentaxの実RAW初期値・Resetとfalse Recipe再Openの未確認は解消した。実NativeのWB候補・Curve・Geometry往復、Thumbnail／Export process、実ユーザーDBの既存tuple、ユーザーGUI操作は未検証であり、この追確認をP5またはP4全操作の完了とは扱わない。P4-CのFake Native／HTTP／Frontend回帰件数と残件は`LIGHTCRAFT_V020_UPGRADE_PLAN.md`のP4-C記録を参照。

### M1 — Medium：Native snapshotとUIの既定値補完が混ざる

`_settings_json`はbounded JSON検査だけでなく既定値を追加する。`with_legacy_optics_defaults`は部分的に不足したOpticsにも値を追加する。Curveは全キー固定検査が保存storeでも呼ばれるため、単なるUIの未知field非表示では済まず、上流の項目追加が保存・open・Historyへ波及する。

推奨：次回更新前に、Native confirmed snapshotの保持とUI表示用fallbackを分け、既知の値の型・範囲・サイズ検査を残しつつ未知fieldを保持する。省略復元に実際に必要な処理（H1など）は送信境界へ限定する。既存正常Recipeのreceiptを一括変更しない。互換性方針を緩和する提案ではない。

### M2 — Medium：Resetの「変わらない全項目」を再証明している

個別Reset／sectionToggle／Optics flag／vignetteStyleは操作前snapshotを書き換えた期待値と全体比較（`lightcraft_raw.py:1743`）。Grading、Effects、Detail、Opticsカテゴリにも同種の比較がある（`:1760`以降）。DetailではUI非公開のEnhance項目のReset意味まで知っている。

`optics.lens_profile`は実害の例。旧allReset検証はfalse固定だったが、Nativeの写真別import defaultsはembedded lensでtrueとなり得る。`43a5085`は写真のimport Opticsを保持して検証するよう修正した（`:1740`、移植計画`:96`）。これは写真別期待値を得る改善であり、GenzoRoom側でレンズ判定を再実装していない。既に修正済みの問題を現行不具合として数えない。ただしOptics全体一致への依存は残る。

推奨：操作成功、confirmed readback、GenzoRoomが約束する操作境界を中心に検証する。Nativeが正当に変更し得る無関係項目まで固定しない。特にRAW default／section default／control defaultは同じではない。49個のUI control定義（範囲・刻み等）自体はBであり、無条件削除の対象ではない。

### 編集操作を単純化してはいけない境界

| 操作 | 現行経路・複数コマンドの理由 | 評価 |
|---|---|---|
| 通常slider、Sharpen／NR | `set_controls`→`develop.set`、Optics含む場合はJSON mapping→merge→get | B。現像式を複製していない。 |
| WB／As Shot | Native WB command／merge、写真別As Shot、readback | 色変換はNative。値・modeを適用するアプリ境界を維持。 |
| WBスポイト／Auto | read-only候補→identity再確認→ユーザー確定後WB merge | 候補取得中にsettingsを変えない要件。wbPick→Undoで代用するとcancel・競合・History意味が変わる。 |
| ポイントカーブ | `develop.curve`、`develop.targeted`、begin/end/cancelInteraction、GenzoRoomのHistory1操作 | `lightcraft_raw.py:1025`、`:1123`、`:1258`。連続操作と確定を分けるための複合操作。曲線補間はNative。 |
| Color GradingカテゴリReset | UI公開3 bandのみmerge、非公開globalを維持（`:1710`） | 標準resetSectionはglobalもResetするため、単純置換不可。UI仕様の値設定は維持し、全snapshot予測比較を別に評価する。 |
| Crop／Straighten／Rotate／Flip | `raw_geometry.native_command`→Native→readback、gestureの開始／確定はアプリ | Nativeのfitting／orientation結果を確定値として保存。 |
| 個別／カテゴリ／全Reset | reset command、必要時As Shot、allResetではdisabled_sections再適用（`:1700`） | bypass保持と一操作のHistory／失敗rollbackはGenzoRoomの責務。コマンド数を減らすために消してはいけない。 |

### M3 — Medium：編集sessionとExportの復元adapterが分岐

編集sessionの`_settings_json`／`_restore`に対し、ExportはGrading／Curve補完とWB scaleだけの比較viewを別に持ち、reset→merge→getを直接発行する（`raw_export_artifact.py:37`、`:324`、`:380`）。将来H1を一方だけ直すと出力経路に残る。Thumbnailは`raw_thumbnail_generator.py:46`の独立sessionを使うため、編集session側の修正を共有できる。

統合可能なのは**完全snapshot送信payloadの準備と比較用表現**。Exportの独立process、入力コピー、出力検証、XMP自動書込み禁止、原本保護、Queue／生成物管理まで編集sessionへ統合する必要はない。MCP応答取得もExportのローカル`tool()`とruntime adapterで別実装だが、単に似ているという理由で全通信層を作り直さない。H1修正時に両復元境界を確認し、残る整理はP5の既存範囲で行う。

## 5. Geometry・Previewの評価

### 座標系と処理順序

Native `pipeline/geometry.rs:1`、`:58`はorientation→Warp／lens／perspective→Crop＋Straighten→flipの座標処理を所有する。`geom/crop.rs:38`の`output_to_source`はcrop rectへの拡大・移動後、画像中心の逆回転を行う。

GenzoRoomの`rawTargetPoint`はflipを戻し、crop rectへ移動・拡大し、中心の逆Straightenを行う。orientationはsource寸法の軸交換（`rawTargetOrientedSize`）として扱う。WB／Curveがoriented sourceを要求するので、元センサー座標まで逆orientationする必要はない。`ImageViewer`でCSS／表示bitmap座標を処理するため、Region overlay専用のWB座標演算を別実装していない。

Crop編集中はNative `render_job(..., apply_crop=false)`が未Crop／未Straighten画像を生成し、orientation／Warp／flipはNative側に残る。Frontendはそのbitmap上にcrop枠と暫定角度を表示する。Rotate／Flipは標準photo commandへ送る。`rawStraightenTool`の基準線角度算出はユーザー入力の解釈であり、画像の回転処理ではない。

### M5 — Medium：暫定Crop境界とスポイト座標の前提

`rawCropDisplay.ts:44`以降のMoveはNativeに似た最近傍offsetのpolygon clippingを持つ。resizeは`constrainDraft`による保守的な暫定表示であり、Native solverとの完全一致を実装していない。確定pointer intentはNativeへ送るので画像生成・保存結果をJSで再現しているわけではないが、Nativeのdrag仕様変更時に操作中の枠と確定結果が跳ねる保守リスクがある。標準MCPに非変更型のcrop候補計算APIは確認できない。応答待ちだけに置換すると操作感が変わるため、直ちに削除しない。

スポイト側の変換はcrop／angle／flipまでで、Warp逆変換やNativeが境界制約後に縮めた実Frame cropを受け取る仕組みではない（`rawTargetCoordinates.ts:10`対`N:crates/pipeline/src/geometry.rs:58,92`）。これは必要な座標adapterの**適用範囲の懸念**であり、WBアルゴリズムをGenzoRoomが実装しているという指摘ではない。WB候補はoriented Thumbの生のsampleを読む。一方、Curveの`N:crates/engine/src/cmd/color.rs:25`はNativeの`plan.frame.norm_to_out`を通して現像proxyを読むので、Curveにも同じWarp逆変換が必要だとは断定しない。両者に共有する保存cropと実Frame cropの関係、WBのWarp適用時のsample位置は別々に確認する必要がある。lens／perspectiveが座標を動かす写真で実表示点とNative sample点が合うかは本監査では未実証。P3のJPEG／crop／rotate検証実績だけで全Warpの正確性を保証しない。

次回更新時は、Native公開座標契約とこの2つのUI変換境界を重点確認する。新しい座標API patchを今すぐ追加することは推奨しない。具体的なずれを再現した際、既存Native変換を小さいAPIで公開する案と現在のadapter維持コストを比較する。

### Whole／Region／品質／スケジューリング

Wholeは`Session::render_job`、Draftは`job.draft()`、Beforeは`before_settings`を使用（`P:225`）。Regionは`region_job`／`region_job_before`→run→acceptであり、GenzoRoomがGPUを選択したりStageCacheを操作したりしない（`P:287`）。PNGとFrameを受け、kind／quality／window／寸法／geometryを検証する。

Frontendの`rawWholePreview`、`rawRegionPlanner`、`rawRegionAuto`、`rawRegionSchedule`、`rawRegionDelivery`はviewport／DPR／Zoom／Pan、要求の集約、Whole不足時のRegion、Before／After対、URL寿命とstale排除を扱う。BackendはNativeの直列操作、最新pending、cancel後の完了待ち、settings再読取りを所有する。両層のgeneration guardはそれぞれUI表示とNative sessionの競合を守るためで、重複削除の対象ではない。Regionの表示pixel budgetをStageCache容量制御と誤分類しない。

## 6. managed patchの機能・契約別分析

active manifestは1本のみ。SHA-256=`ca30ff958ff5fbbd04e8e50b31c7c01a6319b7864b49ef8e506c3f20acc5f2ab`、17ファイル、+626/-35（manifest記載）。行数を結合度の判定基準にはしない。

| 機能／契約 | Native変更・API | 必要性／標準代替 | 内部介入・次回競合・削減余地 |
|---|---|---|---|
| Whole／Crop／Before／Draft bridge | `mcp/headless.rs::call(ui.render)`、`tools.rs::helper_tools/render_photo/call_tool`。`include_frame`、`crop_edit`、`before`、`quality`、kind／quality／Before fingerprintを公開。`P:218,681,771` | Engineのjob／draft／before設定を使用。標準MCP render_previewには追加引数・Frameがないためbridgeが必要。 | 主にB。標準MCPが同等契約を提供すれば削除可能。独自Before設定の再計算は不要。 |
| 実描画Frame伝播 | `pipeline::Rendered`、CPU `render_impl`、GPU `render/read_deep`、quick／stand-in／title／UI test constructor。`P:97,186,906,937` | 実画像に対応したFrameが必要。標準Renderedはimage／histogram／deepで、Frameを返さない。 | D。GPU renderとprivate `read_deep`、CPUの内部local frameに介入。ただしbuffer管理・現像式・GPU選択変更ではない。結果型にfieldが増える度にconstructor競合が起こり得る。既存機能を保った即時削除不可。 |
| Geometry descriptor 2／原本寸法 | `mcp/preview.rs::canonical_crop/frame_metadata`、`Frame::native_size_at`、sha2依存。`P:389,884` | Whole／Regionの同じgeometryを識別し、表示密度を求める。標準MCPに同等のopaque identityと寸法がない。 | C/D。Frame、Warp、lens stages／planesを列挙し、gain-only vignette除外、1/256px量子化を判断する。公開Rust fieldでもアプリ向け安定契約ではない。M4。 |
| Region plan／render bridge | `ui.region`、MCP `render_region_preview`、schema。`P:287,496,800`付近 | 標準Engineにregion jobがあるがMCPに公開されていない。画像cropをGenzoRoomで代替すると高解像度全体描画が必要になり現機能の同等代替ではない。 | job実行はA/B。planはcatalog photo、develop、embedded_lensからFrameを別構築するC/D。Engineの`region_job_of`にも類似Frame構築がある（`N:engine/src/media/session.rs:365`）。現時点では同じ組立てだが、将来Engine側だけ変わるリスク。 |
| read-only WB候補 | Engine private `wb_candidate`、`develop.wbCandidate`、MCP `estimate_white_balance`、既存wbPickをhelper利用へ変更。`P:13,681,800`付近 | 元のwbPick／Autoは即時変更。候補確認／cancelを維持するには読み取り専用境界が必要。 | Dを含む。source_info／source_now(Thumb)、oriented画像の5×5 sample、`auto_wb`を既存実装から共通化。Python／TSでWB式を再実装していない。upstream wbPickのsample方法変更時に追従が必要。現patch内ではwbPickとの計算重複を減らしている。 |
| 契約test・補助module登録 | Engine／MCP tests、lib.rs、Cargo.lock等 | 必要なread-only・Frame／PNG／Region応答の検証。 | 独立した製品機能ではない。patch数削減のために削除しない。 |

### M4 — Medium：Geometry metadataが残る最大のNative内部結合

特にdescriptorは、どのWarp成分が座標を動かすか、どのlens stageを含めるかをGenzoRoom管理patchが知っている。RenderedのFrame伝播は型追従、descriptorは意味追従であり、後者はcompile成功だけで検出できない変更があり得る。

推奨：当面はNative内の同一helperに閉じ込め、GenzoRoomへWarp構造を漏らさない。upstream更新時はまず標準のFrame／geometry identity／region情報公開を調査し、同等ならその部分を置換する。標準APIがないまま別の独自Frame APIを重ねても結合度は下がらないため、今は追加patchを提案しない。Region planと実jobの設定／lens選択が同じかを変更差分に応じて確認する。GPU全内部を監査する必要はない。

1本のpatchにはWB候補とFrame／Regionという独立機能が同居する。機能一覧とhunk対応を維持する価値はあるが、同じ`tools.rs`／`headless.rs`に触るpatchを機械的に分割すると適用順依存が増える。ファイル数・patch本数自体の削減を目的にしない。WB部分を上流化／廃止できる時点での機能単位の撤去が有効。

## 7. StageCache／GPU関連の残存分類

| 区分 | 確認結果 |
|---|---|
| 現行描画・active patch | StagePool、admission、retained capacity、execution outcomeの独自公開・制御はない。`_raw_preview`はstage_cache引数を受けるが送信しない（`lightcraft_runtime.py:697`）。GPUファイル変更はFrame伝播。 |
| 実行中の標準API利用 | `app.memoryBudget` 1024 MiB設定と`app.gpu`照会は残る。通常起動では`LIGHTCRAFT_GPU_BACKEND`を注入せず、Windows既定DX12を固定upstreamへ委譲する。診断Sessionの`off`／`dx12`条件指定は測定条件に限る。内部GPU fallback／Buffer所有のDではない。固定budgetの運用選択は別問題。 |
| 実行中だが効かない旧設定 | `LightCraftRawSession.__init__`が`GENZOROOM_RAW_STAGE_CACHE*`を検証する（`:544,575`）。無効値なら失敗するが、正しいONを指定しても現行Native要求に反映されない。完全なdead codeではない。 |
| 実行可能な旧診断UI | `DeveloperPage.tsx:112`→`RawPreviewDiagnostics.tsx:149`、`windows_local.py:123`→`raw_diagnostics.py:211`。ON/OFF試行を作るが現在の`frame.metrics`はtiming／PNG digestだけ（`lightcraft_raw.py:2184`）。Frontend `rawDiagnostics.ts:112,122`はstageCache metadataを必須にする。現行Native応答との不整合がある。 |
| 旧fallback／署名 | `_raw_preview`の旧crop_edit payload分岐、`_validate_crop_png`、旧StageCache error mappingなど。現行capabilityではsimple_cropを選ぶ。現行の受入要件として維持する必要は薄いが、削除時には呼出し確認が必要。 |
| buildの旧版専用処理 | `build.py:341`はwholeFrameContract=1で新probeへreturn。後続旧StageCache probeはactive manifestでは実行しない。旧manifestを明示すれば使用されるため、すべて未使用とは言わない。 |
| 非active成果物・研究履歴 | `0002-v0.18.1-native-contracts.patch`、`0003-v0.18.1-lens-profile-info.patch`、`porting/v0.20.0/0002-v0.20-native-contracts.patch`と旧研究記録はactive manifest対象外。現行StagePool依存の根拠にはしない。 |

P6前の起動設定整理（2026-11-13）では、通常起動の`LIGHTCRAFT_GPU_BACKEND`注入を撤去し、固定upstreamのWindows既定DX12へ委譲した。明示`off`／`dx12`は診断条件だけに残す。詳細とfocused／実EXE検証結果は移植計画の「P6前：GPU backendの既定動作へ委譲」を参照。

**M6 — Medium：** 現行診断UIと無効なStageCache指定を整理する。Nativeへ内部制御を再導入して旧診断を復活させる案は不適切。timing／quality／表示成功等の現在取得できる測定へ合わせ、ON/OFFが実際に切り替わるかのような表示をなくす。診断UIの実操作は未実施で、コード上のproducer／consumer不一致として報告する。通常編集のPreview失敗を示すものではなく、P4-Cの編集受入を止めるHighではない。

`raw_preview_sequence.py:16`のstageCache=offという測定条件ラベルも、現在の内部キャッシュ無効を証明しない。これらの名称・試験fixtureを残すと、次回更新で旧内部契約を再び必須と誤解する保守リスクがある。

## 8. 重複処理の整理

| 対象 | 実際の重複／異なる責務 | 推奨範囲 |
|---|---|---|
| settings補完・復元 | 編集sessionとExportで補完集合・比較表現が異なる。Thumbnailはsessionを再利用 | M3のpayload／比較helperのみ共通化候補。process／Queue ownerの統合は不要。 |
| Reset構築 | control tableのdefault、DETAIL_RESET_DEFAULTS、カテゴリ別予測値にNative Reset意味を分散 | M2。既定値の重複表を増やすより予測比較を減らす。Grading限定Reset／bypass保持は維持。 |
| Geometry | Native crop solverとJS暫定境界、Native output_to_sourceとJS座標adapter | 前者はC、後者は必要なB。WB／CurveはrawTargetPointを共有済み。全面統合やJS側Warp実装追加は勧めない。 |
| Preview要求 | Frontend表示planner、Backend wire変換、Native job生成 | 表示・通信・画像生成という別責務。同じsize/windowが現れるだけでは重複でない。RegionのNative Frame再構築はM4。 |
| response検証 | MCP transport、Backend PNG／echo、Frontend owner／型確認 | 別信頼境界で維持。変更しない全settings比較と内部metadata必須検証のみ削減候補。 |
| History同期 | Native interactionとGenzoRoomの永続History／CAS／saveId | Nativeの短期編集操作とアプリ永続履歴は別責務。Native Historyへ一本化するとretry／旧Recipe保持／複合操作が変わるため提案しない。 |

## 9. v0.18.1 → v0.20.0移行コスト

### A. upstream変更への必要な追従

- GPU `render()`の戻り値が`Option<Rendered>`から`Option<Output>`へ変わり、Image／OnScreen／Deepに関わる結果経路が増えた。両固定HEADの`crates/gpu/src/render.rs`を確認。Frameを結果へ追加する既存拡張でもconstructor追従は不可避だった。ただしexecution outcomeの全面拡張まで必須だったわけではない。
- 新`nr_outliers`はRAW import true、通常default false、省略false、partial mergeという契約差を持つ。公開settingsを保存復元するadapterの対応は必要。旧画質の再現を要求する問題ではない。
- Beforeのprofile別source選択、source_identity／decoder／lensを含むjob生成へ進化している（固定v0.20.0 `engine/media/session.rs:45,59`）。旧patchでsourceを先取り・保持する方式はこの変更を理解して移植する必要があった。標準job利用なら内部追従の多くを上流へ任せられる。

### B. GenzoRoomの過剰依存に由来する追加作業

- 旧patchのGPU admission／capacityは`Arc` identity、vector capacity、device buffer確保量へ介入（旧`0002-v0.18.1-native-contracts.patch:242,374`）。MCP側StagePool、実行結果必須化も含む（同`:602,945`）。このためエンジン内部の新しいbuffer／stageを数える作業が発生した。これは通常のPreview API利用には不要。
- `c4dea82`はGPU結果・execution移植、`075e3f6`はStageCache容量計量移植を累積暫定patchへ記録した。`5051c1c`はStageCache ownership簡素化へ変更。さらに`0c347e8`とそのrevert `f840388`、`45dc5ae`の責務再整理へ続く。履歴は単なるcommit数ではなく、内部制御を移植した後に廃止する手戻りがあった根拠である。
- `43a5085`のlens_profile不一致は上流APIが存在しないための作業ではなく、GenzoRoomの全写真default=falseという予測が不要な失敗を作った実例。既存settings全体一致とLegacy補完も、更新時の確認対象を増やす。

### C. 更新と同時に行った設計改善・機能整備

- `45dc5ae`の恒久統合契約、`5efc2b7`の新Whole Frame基盤、`bbfed90` Crop、`52a8fd9` Before／Draft、`c5fb59b` Regionは、旧内部契約を全面移植せず標準Engineへ戻す再接続だった。必要機能は維持するが、移行コストには設計転換分が含まれる。
- `7e2af6e`のread-only WBとターゲット座標接続は既存UI要件を新bridgeへ接続する整備。WB式の独自開発ではない。
- `6ad14b2`のRecipe監査と`40a84cd`の完全identity一致・非互換初期値起動・旧Recipe保持は、エンジンの型変更だけでは必須でないアプリの復旧方針整備。今回の監査はこの決定を変更しない。

**評価：** 初期方針では旧D依存の全面追従がコストを増やし、その後の境界再設計が追加コストを要した。現在のactive patchが小さいことだけから、過去の移行も軽かったとは判断できない。逆に、過去に巨大な暫定patchが存在したことから現行も同じ結合度だとは判断しない。

## 10. 優先順位・実施時期

| ID／優先度 | 修正範囲・保守削減効果 | 機能影響・難易度／回帰リスク | Native patch | 時期 |
|---|---|---|---|---|
| H1 High | Detail Reset検証、完全snapshotの省略false送信／比較。復元失敗を各経路で別々に直すことを防ぐ | 中。Undo／Redo／rollback／再Open／Exportへ波及するため局所integration確認が必要 | 不要 | P4-Cの広い受入より先に局所修正。P5までに共通復元とExport境界を確認 |
| M1 Medium | Native snapshot保存とUI fallbackの分離、Curve等のunknown field保持 | 中。receipt／History整合を壊さない段階的変更 | 不要 | 次回更新前。P4-C／P5を止める理由なし |
| M2 Medium | Resetの全settings予測比較を減らす | 中。bypass、As Shot、global grading保持を残す必要 | 不要 | H1の必要部分のみ先行、残りは次回更新前 |
| M3 Medium | session／Exportのsnapshot adapter共有 | 中。process分離・原本保護維持。共通化し過ぎると回帰範囲拡大 | 不要 | H1対応を両経路で揃え、P5の既存範囲で確認 |
| M4 Medium | Frame／descriptor／Region planの内部結合を一か所へ限定、標準代替の継続調査 | 高。geometry identity、Before／Region配置の回帰リスク。今すぐ書換えない | 置換時は変更あり | 次回upstream評価時。標準同等機能がある時に削減 |
| M5 Medium | 暫定Cropとターゲット座標の前提確認・維持範囲明確化 | 中〜高。操作感／sample位置。Warp影響は未実証 | 今は追加不要 | P4-C予定の幾何確認では懸念を意識。具体的ずれが出た場合だけ修正、構造整理は次回更新前 |
| M6 Medium | 現行診断をtiming／品質等へ合わせ、効かないStageCache指定を整理 | 低〜中。診断表示・fixture。通常編集のNative経路変更不要 | 不要 | 次の診断整備／次回更新前。P4-C blockerではない |
| L1 Low | 必要な標準API adapter、stale排除、History／CAS、複合操作 | 現状維持。削除は機能を壊す | なし | 継続 |
| L2 Low | 旧patch／旧probe／研究記録の整理 | 履歴と現行を明確化。保存された再現手段を無断削除しない | active変更なし | 将来の保守時。今回削除しない |
| L3 Low | patchの物理分割 | 本数削減効果は小さい。共通targetの適用順リスク | 分割する場合のみ | 独立機能の上流化／撤去時に検討 |

## 11. 検証と限界

本監査で実行した確認：

- Python baseline：リポジトリ`.venv`のPython 3.14.5。
- `backend`をcwdとして同Pythonで`pytest tests/test_raw_controls.py tests/test_raw_category_operations.py -q --disable-warnings`：**66 passed、失敗・skipなし**。既存の入力／Reset／History／失敗rollback境界を確認する目的で選択。Nativeを模したfixture中心であり、v0.20.0 RAWの`nr_outliers`を実証するsuiteではない。
- 初回sandbox実行は進捗8件の後に停止し中断。局所probeの20秒stack dumpで、asyncioのevent loop作成中に`socket._fallback_socketpair`→`accept`で待つことを確認。同じPython・同じpytest引数を権限拡張で再実行した結果が上記66件。同期部分だけの切り分けは8 passed／10 deselected。初回の停止を製品のテスト失敗とは分類しない。
- H1の追加メモリ内probe：全UI controlとOptics flag、Enhanceを持つ合成settingsの`nr_outliers=true`から、Native仕様どおりfalse省略のreadbackを作り、実`apply_history_operation`の検証closureへ渡した。**`raw_operation_readback_mismatch`として拒否することを確認**。非同期I/Oを伴わないstubでcoroutineを直接完了させた。テストファイルの追加やNative実行はしていない。
- active patchの実SHA-256はmanifest記載と一致。固定HEADを確認したpatch済みcheckoutに対する`git apply --reverse --check`成功（checkのみ、撤去・適用なし）。新しいclean checkoutへのforward適用・buildの再検証ではない。
- `git diff --check`および追加文書の差分空白確認を実施。stage済み文書も`git diff --cached --check`で問題なし。

製品コード、既存テスト、Native patch、manifest、DB schema、EXEを変更していない。Nativeのbuild／patch適用／GUI／Computer Use／Immich操作は実施していない。Frontend変更がないためTypeScript／production buildは対象外。全Backend suiteは本監査の差分が文書のみで、上記の接続境界に絞った確認で足りるため実行しない。既存成功記録を実機確認の代わりに扱わない。

P4-Cに残す検証は、現行tupleでのRAW／JPEG保存復元、Detail ResetとON／OFF snapshot、Undo／Redo／Jump／rollback、WB候補cancel、Curve／Crop／Straighten／Rotate／Flip、asset切替と保存失敗境界。P5では同じsnapshotのThumbnail／Export、原本保護、Queue／Immich登録を確認する。これは後続工程への判断材料であり、本監査で実施済みとはしない。

## 12. 結論

エンジン内部の大規模再移植やStageCache制御の復活は不要。H1を先に局所対応してから既定のP4-Cを進める。P5前には省略falseの復元を編集sessionだけでなく独立Exportにも残していないことを確認する。その他のMediumは次回更新に向けた改善候補であり、現行機能を削ってまで一括refactorする必要はない。

次回更新では「標準APIが増えたか」「Reset／snapshotの公開意味が変わったか」「Frame／Geometryの内部構造が変わったか」に対象を絞る。既存の固定commit・managed patch・実binary／receiptの確認は維持し、旧cache／GPU内部の再証明や旧版との画素一致を受入条件に戻さない。
