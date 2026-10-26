# LightCraft 更新・GenzoRoomパッチ管理

この手順は開発用・配布用のどちらのLightCraftにも適用する。現在の管理基準は **v0.14.0 / `03c88c166c054c009db2a47187d59991f6232b85`**（U3自動検証PASS、短いWindows実機受入待ち）。固定値とパッチdigestの正本は [`native/lightcraft/manifest.json`](../../../native/lightcraft/manifest.json)。独自変更は本家commitに含めず、同directoryのGit patchとして保存する。patchはfull-index形式とし、`.gitattributes`でLFを固定してWindows checkoutでもdigestを維持する。以下のA2〜C2記録は当時のv0.10基準の履歴であり、U3の結果は[追随調査§15](LIGHTCRAFT_0_14_UPGRADE_REVIEW.md#15-u3実装検証結果2026-10-26)を参照する。

RAW Preview統合はLightCraft v0.14.0で機能完了している。Whole Draft/Full、Native geometry/DPR、Region/Pan/Zoom、Before/After、stale result handling、Recipe restore/RAW Reset、Smoke、Developer Diagnostics RAW Benchmarkを含む。初回RAW open約2秒、cold first Region Plan約660ms（約99.96%がFull source初回生成）、同一document再Plan約0.25msはblocking issueではなく将来の性能最適化候補。条件付きmetadata-only Plan、Full source prewarm、source生成内部最適化は未実装の将来検討であり、[Region設計§18](RAW_REGION_PREVIEW_DESIGN.md#18-raw-preview機能完了と性能課題の扱い2026-10-26)に判断根拠を記録する。

## 標準更新方針

GenzoRoomは開発中のため、LightCraft更新の標準受入は変更に直接関係するfocused regressionに限定する。過去の研究文書やPhase記録は設計背景・当時の受入証跡・問題発生時の調査資料であり、記載された全試験を更新ごとに繰り返す手順ではない。

通常の更新では、次の項目を確認する。

- upstream tag／commitの固定と、更新に関係する差分の確認
- managed patchの追随、manifest／patch digest／targetsの更新
- Native focused testとbuild、および生成・採用する実binaryのprobe
- receipt、manifest tuple、実binary SHA-256の整合
- Before／Preview／Region contractとgeometry descriptorの整合
- CPU／DX12それぞれの基本描画
- persisted RAW Recipeのbest-effort restoreとRAW編集Reset
- RAW Viewer smoke testと短いWindows実機目視

必要なテストやprobeは、変更したNative contract、GenzoRoom adapter/API、Frontend接続点に絞る。これらの確認を満たすために不要なら、全Backend／Frontend test suite、全機能のbuildや追加監査へ広げない。

通常更新で自動的に再実行しない項目：

- 大規模performance benchmark、旧版対新版の詳細side-by-side、数%／数十ms差の性能評価
- RSS／VRAMの長時間測定、Pan大量trace、scheduler timing matrix
- rho／hysteresis、Region budget、StageCache budgetの比較
- 無関係なJPEG／Export／Home機能の全面回帰
- Computer Useによる長時間自動操作
- 旧LightCraftとのpixel-perfect／pixel-identical再現確認

これらは標準受入条件ではない。A2／P0／P2／B1／C1／C2／C3-Aなどに残る詳細benchmark、memory／GPU計測、高entropy PNG試験、大量Pan／Zoom trace、policy比較は各機能を導入した時点の証跡であり、毎回の更新では再実行しない。実装したNative contractそのものを変更した場合だけ、そのcontractに直接必要なprobeを選んで実施する。

追加調査は、明確な異常の兆候を確認した場合に、その影響範囲へ限定する。例は明らかな性能回帰、geometry／Preview位置ずれ、GPU fallback異常、OOM、RSS／VRAMの継続増加、hang、RAW画質の明確な破綻、contract mismatch、Recipe restore失敗、Viewer smoke failure。原因が未確定という理由だけで大規模benchmarkへ進まず、観測された問題を切り分けるためのfocused調査から始める。

前方互換性については、過去LightCraft versionとの完全互換、旧versionによる再現環境、multi-engine runtime、Recipe migration framework、過去Historyの完全再現、旧版とのpixel-identical出力を必須要件にしない。persisted RecipeはAsset ID、source content hash、engine name、対応settings schemaが合えば、保存settingsを現LightCraftへそのままbest-effort restoreする。engine version／commit差だけでは拒否しない。settingsを実際に読めない場合はRAW編集Resetで現行engineの初期状態から再開できればよい。将来、release安定期に入った段階で必要なら互換方針を再設計する。

新versionに有用な修正・改善があり、上記focused regressionに問題がなければ採用できる。旧versionより高速であることや、小さな性能差が改善していることは採用条件ではない。更新手順の正本はこのガイドであり、Phase文書や研究記録の全試験を毎回の要件として扱わない。

## 管理対象

| パッチ | 目的・変更対象 |
|---|---|
| `0002-v0.14-native-contracts.patch` | 現行v0.14用。MCPのBefore＋adaptive品質・frame・StageCacheおよび独立Region plan/render契約。pipeline/GPUの実Plan sidecarとbuffer計量、Engine/stand-inの戻り値追随、MCP/native fixtureを含む。全targets・digestはmanifestで管理 |
| `0001-native-before.patch` | 旧v0.10用。変更せず保持。`versions/0.10.0.json`が旧commit・digest・targetsを固定する |

### U3以降の管理と互換性

- `build.py`は固定HEADとupstream `Cargo.toml`のversion、patch digest/targets、source全diff、公開Before/Preview/Region各1、geometry descriptor 2、共有Region schema/fixtureを照合する。共有artifact検査をversionで省略しない。
- manifest更新後は `python native/lightcraft/sync_identity.py` でFrontendのstrict identityを生成し、`frontend/src/lightcraftEngine.ts`を手編集しない。Backendも同じmanifestを読み、Windows配布にも収録する。同期は回帰テストで検査する。
- `build.py --manifest native/lightcraft/versions/0.10.0.json --source <旧専用checkout> --build` で旧基準を再現できる。`--binary`にも同じ`--manifest`を指定する。旧patch・binary・隣接receiptを上書きしない。
- 永続Recipe復元はAsset ID・source content hash・`lightcraft`名・対応settings schema（現在は1）を照合し、engine version／commit差では拒否しない。settingsを現engineへそのままbest-effort restoreし、失敗はnative restore/readbackの実際の境界で扱う。成功後の新規保存は現tupleで別行として記録し、旧Recipeを事前変換・書換えしない。Historyと同一実行内snapshotのstrict ownershipは維持する。完全な将来画素互換は保証しない。schema/DB migrationはない。
- Settingsはready processのhandshake版と、実EXE SHA／manifest全patch tuple／隣接receiptが一致した場合だけLightCraft版を表示する。未接続、不正／欠落receipt、世代変更で推測表示しない。receipt読取りも既存のbounded daemon検査ownerに含める。
- RAW編集・Recipe tuple発行も検証済みartifactを必須とし、version文字列しか確認できないprocessへ固定commitを付与しない。不正／欠落receiptではRAW capabilityを無効にし、import前に拒否する。JPEG／Backend起動は独立して継続する。
- 新EXEは `.tmp/lightcraft-0.14/target/release/lightcraft-cli.exe`、receiptは隣接 `lightcraft-cli.genzoroom.json`。Windows開発checkoutではenv未指定時に現在manifestからこのmanaged candidateを探索する。候補は起動時に隣接receipt・実SHA・manifest tuple・contractをstrict検証し、一つでも一致しない場合RAW unavailableとなる。`GENZOROOM_LIGHTCRAFT_EXE`は旧版検証・別build・debug binary用の優先overrideで、override先も同じstrict検証を通す。
- `.tmp`探索は非frozenのWindows開発checkoutに限定する。配布版の通常runtimeへ持ち込まず、将来のbundled artifactも同じreceipt/manifest検証境界へ接続する。自動downloadや旧LightCraftの自動切替は行わない。

> **過去の導入記録／受入証跡:** 以下のA2／P0／P2／B1 probe詳細は、その契約・機能を追加した当時の検証記録であり、LightCraft更新時の標準受入として毎回実行するものではない。契約実装を変更する更新では、変更範囲に直接必要なprobeだけ選択する。

A2では同じpatchへadaptive契約1を統合した。`quality`／`preview_contract`／`stage_cache`と有限budgetの検証、headless job実行・typed metadata、CPU/GPUの実Planを返す`Rendered.frame` sidecar、原本gridへのnative寸法投影、stage保持bufferの計量を含む。`preview.rs`は新規のMCP helperであり、独立した現像／永続cache基盤ではない。変更対象一覧とSHA-256の正本はmanifest。新規依存はworkspaceですでに固定された`sha2`をMCPでも使うためのCargo.toml／lock追記のみで、upstream versionは変えない。

従来引数だけならFull・既存metadata形状を維持する。明示quality、preview_contract=1、stage_cacheのopt-inでは実quality／frame／stageCacheを返す。CPU/GPUアルゴリズム、`run/accept`とsource cache、Before import基準は維持する。stand-inの`Rendered.frame=None`は実geometryの証拠にしない。Beforeはnative `before_settings()`がcrop／orientationだけを現在値に揃え、Afterの手動歪曲補正等を転写しない。hash64はnativeの既存settings hashであり、画像checksumや暗号学的出自証明として扱わない。

## 再現可能な準備・ビルド

> **既存build toolの記録:** 以下のコマンド説明はpatch適用・artifact検証方法を示すもので、列挙されたPhase-era probe全体を通常更新で再実行する指示ではない。標準更新では上記の受入方針に従って変更に関係するfocused test／build／binary probeを選ぶ。build toolが内部で行う検査はそのtoolの実装動作として扱い、旧Phaseの詳細probeを別途重ねて実行しない。

1. 本家から上記commitの**未変更**checkoutを用意する。既存の利用者変更をreset／上書きしない。作業前にHEAD・statusを確認する。
2. GenzoRoomのリポジトリPythonから準備scriptを実行する（PowerShell例、`$source`は専用checkoutの絶対path）。

```powershell
$source = Join-Path $PWD '.tmp/lightcraft-0.14'
.\.venv\Scripts\python.exe native/lightcraft/build.py --source $source --apply
.\.venv\Scripts\python.exe native/lightcraft/build.py --source $source --build
.\.venv\Scripts\python.exe native/lightcraft/build.py --binary "$source\target\release\lightcraft-cli.exe"
```

`--apply`は固定HEAD・パッチSHA-256・clean tracked sourceを検査し、`git apply --check`の成功後だけ適用する。新規管理sourceを完全diffへ含めるため、適用時は`--intent-to-add`を使用する。これは内容のstageではなく、`git diff --cached`が空である制約を維持する。管理外の未追跡sourceは引き続き拒否する。適用済みへの`--apply`はエラーにする。既に適用済みの場合は`--apply`を外す。検証時はsource diff全体が管理patchと一致することを確認し、不一致／部分適用／余分なtracked変更／staged変更／異なるHEADではbuildを中止する。失敗したpatchを無視してbuildする経路はない。管理patch以外のsource変更を残したまま配布しない。

`--build`は検証後に`cargo test --locked -p lightcraft-mcp -- --test-threads=1`、`cargo build --release --locked --no-default-features -p lightcraft-cli`を実行し、**生成したbinary自身**へMCP handshake／tools schema／synthetic PNG import／Beforeと省略時Afterのrenderを要求する。A2 probeはAfter/Beforeそれぞれの明示Draft/Full、品質省略＋契約1のFull、legacy metadataの完全形状、geometryId/native寸法/実PNG寸法、cache off/on/tiny budget、最終Fullの画像一致・settings不変と、不正quality/contract/cache引数の固定code拒否も検査する。成功時だけ隣接する`lightcraft-cli.genzoroom.json`を生成する。receiptはversion／本家commit／patch digest一覧／binary SHA-256／`beforeContract:1`／`previewContract:1`／`regionContract:1`を持つ。旧Before receiptだけではA2対応と認定しない。全工程は非zero exitで中止し、receiptを成功前に発行しない。

binaryの差替え検出には`--binary`を使う。現在のmanifest、receiptと実ファイルのSHA-256を一致確認した後、実binaryのschemaとrenderを再検査する。version文字列だけ、古いreceiptだけ、patchを適用したsourceだけではbinaryを承認しない。receiptは署名済みサプライチェーン証明ではなく、管理されたbuildとローカルファイルの照合記録である。

A5-P0以降のprobeは、追加でGPUを無効化し、CPUの1024px要求／512 MiBでcacheが適用・保持されること、反復とBefore/After、off/on Full PNG一致、settings不変、off切替時の解放を実binaryで確認する。CPU admissionは実sourceと既存bufferの容量・追加確保分から計算し、GPU／混在／情報不足は従来の安全側見積りを維持する。probeは合成PNGの契約検証であり、実RAWの性能・RSS／VRAM受入を代替しない。

A5-P2では実source／Planが得られるGPU／混在経路も実capacityと追加確保量で判定し、情報不足のみ旧保守式へ戻す。GPUの実capacity、host共有、CPU fallback分、旧新共存、pool余剰、別所有shared sourceの予約を含む。adaptive metadataのoptional `execution`を検証し、CPU P0 probeではCPU未試行の固定reasonも確認する。さらに独立したDX12 processで合成1280×963→1024pxのOFF/ON、Before、tiny budget、Full一致を検査する。available GPUではrenderごとのgpu_successを必須とし、adapter不在は明示skipとCPU結果検証に分ける。

P2検証済みEXEは`I:\code\genzoroom\.tmp\lightcraft-a5-p2\target\release\lightcraft-cli.exe`（隣接receipt付き）。旧A2/P0版は上書きしない。現行SHAと試験記録は[DX12調査§12](RAW_DX12_STAGE_CACHE_RESEARCH.md#12-a5-p2実装結果2026-10-24)を参照。開発用固定配置`.tmp/lightcraft/current`は、利用中EXE排他・backup・EXE/receipt一体切替の独立検証を要するため今回は導入しない。従来どおり明示的なEXE設定と`--binary`照合を使用する。

B1では同じ管理patchのPNG envelopeを17 MiBへ拡張し、GenzoRoomの2048px／2048²画素・MCP line24 MiB契約に揃えた。既存probeに加え、独立DX12 processで1536／2048要求の実PNG寸法、Before/After・Full ON/OFF、Draft→Full、tiny budget拒否後の描画継続を検査する。GPU無効でも2048を確認し、別の高entropy CPU2048²画像で5 MiB超のPNGと24 MiB以内のlineを実検査する。単なるMCP成功やHTTP 200では受入しない。

最新B1 EXEは`I:\code\genzoroom\.tmp\lightcraft-b1\target\release\lightcraft-cli.exe`、隣接receipt付き。SHA：`09d38369d4cbe0274fe363862d139097be063845f65a31a2bbd3931d4357a02e`。旧A2/P0/P2を上書きしない。`--binary`で実SHAとreceipt、schema、実寸と画像契約を再照合して使用する。安全上限と実機未確認事項は[適応型設計§20](RAW_ADAPTIVE_PREVIEW_DESIGN.md#20-a5完了とb1whole-frame表示解像度2026-10-24)を参照。

## 開発・Windows配布との接続

現行GenzoRoomはLightCraftをinstallerに同梱しない。Windows開発checkoutでは通常のDesktop起動時に現在manifest版のmanaged `.tmp` buildを自動検出し、`GENZOROOM_LIGHTCRAFT_EXE`は明示指定時に優先する。検出・overrideのどちらも実EXE SHAと隣接receipt、manifest、contractsの検証が必要。汎用Tauri開発buildにLightCraftを同梱したり、自動download／本家更新を追加したりしない。

`desktop/packaging/build.ps1`は`-LightCraftExe`または`GENZOROOM_LIGHTCRAFT_EXE`が指定されている場合、packaging開始前に`--binary`を必須実行する。失敗時は配布buildを続行しない。未設定の場合は従来の外部engineなしbuildが可能で、RAW Before対応binaryを含む配布とは扱わない。開発用`.tmp`探索はfrozen配布runtimeでは無効である。将来MCPを同梱する場合は、この検証済みbinaryとreceiptを一組としてstageし、bundle検証でも同じ`--binary`を実行する。未検証ファイルを直接copyする経路を作らない。

runtimeはMCPの`render_preview.inputSchema.properties.before.type == boolean`を世代ごとに調べ、Before応答の`kind`、native import fingerprint、geometry、PNG実寸を検証する。schema非対応やBefore基準を確認できないbinaryでは`beforeKey=null`とし比較操作を無効にする。After／RAW編集は従来どおり利用できる。対応schemaだけを持ち、AfterをBeforeとして返すbinaryは画像検証で拒否し、Beforeだけを失敗にする。runtimeのSHA-256診断とbuild receiptで未変更本家binaryと管理buildを識別する。全配布先で既知hashの登録を強制する方式には変更しない。

A2導入時点はnative契約までで、A3でGenzoRoom runtime／HTTP／Frontendの品質・geometry capability／strict metadata／schedulerを接続した。現在はA5-P2のoptional executionとcapacity計量にも対応し、旧metadata互換経路を維持する。領域描画、最終解像度・容量・timeout・cache採用、実RAWのCPU/GPU性能・peak memoryは別の受入であり、synthetic probe成功と混同しない。

## 将来のエンジン更新

更新は次のfocusedな流れで行う。変更に直接関係しないsuite、benchmarkや旧版比較は標準手順に追加しない。

1. 新upstream version／tag／commitを固定し、関連差分とmanaged patchへの影響を確認する。
2. 専用のclean checkoutでmanaged patchを追随する。`git apply --check`を含め、部分適用・重複・余分なdiffがないことを確認する。本家の現像式を独自に移植しない。
3. manifestのversion／commit、patch digest／targetsを更新し、manifestをidentityの正本として保つ。
4. 変更に関係するNative focused test、build、実binary probeを行い、receipt／manifest tuple／actual binary SHAを照合する。Before／Preview／Region contractsとgeometry descriptorを確認し、CPU／DX12の基本描画を確認する。
5. GenzoRoom側の関連focused regressionを行う。RAW Viewer smokeは下記の単一commandで実行する（persisted RAW Recipeのbest-effort restoreとRAW編集Resetも含む）。変更が影響しない領域の全suiteは実行しない。
6. 短いWindows実機目視でPreview、Before／After、操作可能性を確認する。失敗や明確な異常があれば、観測された範囲だけ追加調査する。
7. focused regressionに問題がなく、有用な修正・改善がある新versionを採用する。旧versionより高速であることや画素完全一致は条件にしない。
8. 更新後のmanifest／receiptと変更した関連文書を揃える。旧Recipeの事前変換、旧engine切替やmigration frameworkは導入しない。

性能benchmark、RSS／VRAM長時間測定、Pan trace、scheduler timing matrix、budget policy比較などはこの標準フローに含めない。明確な回帰等の兆候がある場合だけ、原因を絞る追加調査として実施する。

### RAW Viewer Smokeと任意のBenchmark

repository rootのPowerShellで実行する。Frontendの既存npm依存とrepository `.venv`が必要。

```powershell
.\.venv\Scripts\python.exe native/lightcraft/raw_preview_smoke.py
.\.venv\Scripts\python.exe native/lightcraft/raw_preview_smoke.py --json-out artifacts/raw-preview-smoke-YYYYMMDD.json
```

通常はcorrectnessのみ。実managed EXEのready・receipt／SHA・Preview／Region各contract 1・geometry descriptor 2を確認し、Viewer lifecycleはReact／Region fixture、Recipe復元・失敗後Resetは既存API統合fixtureで確認する。Nativeの全面render probeは重複しない。Draft／Fullのbitmap差は許容し、同revision／viewのgeometry・Native／Full寸法・aspect・表示scale／offset／Whole領域を照合する。ブラウザ実動作・実RAW画質の目視を代替しない。`--json`はstdoutへschemaVersion 1のJSON、短い結果はstderrへ出す。失敗はstageと固定codeで記録する。

JSONは更新時の任意の比較資料として保存できる。過去版とのJSON diffや速度比較は必須工程ではない。生成結果を自動commitしない。

RAW Preview Benchmarkは `/developer` → RAW Preview → RAW Viewerベンチマークで利用する正式なDeveloper Diagnostics。代表RAWのAsset UUIDとCPU／DX12を指定し、ウォームアップ1回＋測定3回で個別結果とmin／median／maxを取得する。既存Full JSON exportにも `rawPreview.viewer` として含まれ、RAW側exportも共通download方式を使う。Asset UUID・RAW path・Recipe・PNGはexportしない。性能回帰の疑い、またはViewer／transport等の改善評価時に任意で実行し、数値を更新の必須性能判定にはしない。

CLIでBackend adapter側だけを軽く測る場合は、同じSmokeへ `--benchmark --raw-file <代表RAW> --json-out <保存先>` を追加できる。これはNative／MCP／Backend経路の観測であり、Frontend decode／Viewer adoptは収集しない（JSONにも明示）。Viewer側を含む測定はDeveloper Diagnosticsを使う。Benchmarkの遅さや取得失敗はSmokeのcorrectness結果を変更しない。実行時間の上限はhang検出用で、性能threshold、旧版比較、長時間memory追跡やpolicy tuningは行わない。

## 上流に同等機能が入った場合

独自patchを削除する場合は、変更するcontractに直接関係する範囲で上流binaryのboolean Before schema、import基準、kind・fingerprint・geometry、PNG／After互換性をfocused regressionとbinary probeで確認する。契約名が異なる場合は最小のadapter変換で同じ保証を満たし、画像種別を推測しない。互換性確認後、manifestの`patches`を空にしてpatchを削除し、nativeの機能テストが上流側にあるかGenzoRoom管理のprobeで代替されることを記録する。clean upstream buildでもreceiptとactual binary SHAを照合する。patch不在を理由に能力検査を省かない。


## C1 Region検証の追加（2026-10-25）

> **過去の契約導入probe記録:** 以下のCPU／DX12、多数の入力境界、高entropy PNG、capacity／budget probeはC1のRegion機能導入時の受入証跡であり、将来version更新の標準要件ではない。Region contractまたは関連adapterを変更する場合に限り、変更した契約境界に必要なprobeを選択する。

固定upstreamは変更しない。同じ管理patchに `region.rs` とtests、C0のschema/contract/fixture artifactを含める。prepareはNative artifactがFrontend正本と一致すること、およびBackend schemaの一致を確認し、不一致ならbuildを中止する。既存Before/Whole tool schemaを拡張せず、独立 `render_region_preview` の `region_contract:1` を検出する。

`--build` は従来の全MCP試験・release build・B1 probeに続けて `region_probe.py` を実行し、成功後のみRegion contract入りreceiptを発行する。`--binary` も同じ実probeを行う。CPUと独立DX12 processで実Plan、Full/Draft、Before baseline、cache OFF/ON/tiny拒否後継続、Whole→Region→Whole、unknown schema/operation/version/oversized拒否、高entropy PNG、Full source選択、settings不変を確認する。GPU adapter不在は明示skipとする。このWindows実測ではDX12を実行した。probeはBackendのmethod-aware bounded transport/validatorを利用するため、repository Python環境とPillowが必要。

C1 EXE：`I:\code\genzoroom\.tmp\lightcraft-c1\target\release\lightcraft-cli.exe`、SHA-256 `2c7b7f01e366c56151dedffa0fc2b2af3496a035e3bba5a384a3fdcc1ac26812`。patch digest `e00ef2754b072076c54da746f145d7edbd87b331fa557f9ca38fd9b5948cc26e`。隣接receiptのupstream commit/digest/SHAとbefore/preview/region各contract1を実ファイルへ照合する。旧B1 EXE/receiptは変更せず残す。

C1初期Region budgetはPNG9 MiB / line13 MiB / metadata16 KiB / 2048軸・2,097,152 pixels。Whole17 MiB / 24 MiBとは分離する。実entropy PNG6,293,375 bytesの転送と超過拒否の境界試験を実施した。source/StagePool capacityをRSS/VRAMと混同しない。DehazeのWhole proxy由来差、実RAW memory peak、overlayの実機画質は別受入。詳細は[Region設計§12](RAW_REGION_PREVIEW_DESIGN.md#12-c1完了region-nativebackend2026-10-25)。現在のViewerはWholeのままで、C1 binaryの検証成功はC2の有効化を意味しない。
