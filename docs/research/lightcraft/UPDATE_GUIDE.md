# LightCraft 更新・GenzoRoomパッチ管理

この手順は開発用・配布用のどちらのLightCraftにも適用する。現在の本家基準は **v0.10.0 / `a2a41383c4fd62fa85a46ccd00998639221f2d3c`**。C4-Dで本家versionは変更していない。固定値とパッチdigestの正本は [`native/lightcraft/manifest.json`](../../../native/lightcraft/manifest.json)。独自変更は本家commitに含めず、同directoryのGit patchとして保存する。patchはfull-index形式とし、`.gitattributes`でLFを固定してWindows checkoutでもdigestを維持する。

## 管理対象

| パッチ | 目的・変更対象 |
|---|---|
| `0001-native-before.patch` | MCPのBefore＋adaptive品質・frame・StageCacheおよび独立Region plan/render契約。pipeline/GPUの実Plan sidecarとbuffer計量、Engine/stand-inの戻り値追随、MCP/native fixtureを含む。全targets・digestはmanifestで管理 |

A2では同じpatchへadaptive契約1を統合した。`quality`／`preview_contract`／`stage_cache`と有限budgetの検証、headless job実行・typed metadata、CPU/GPUの実Planを返す`Rendered.frame` sidecar、原本gridへのnative寸法投影、stage保持bufferの計量を含む。`preview.rs`は新規のMCP helperであり、独立した現像／永続cache基盤ではない。変更対象一覧とSHA-256の正本はmanifest。新規依存はworkspaceですでに固定された`sha2`をMCPでも使うためのCargo.toml／lock追記のみで、upstream versionは変えない。

従来引数だけならFull・既存metadata形状を維持する。明示quality、preview_contract=1、stage_cacheのopt-inでは実quality／frame／stageCacheを返す。CPU/GPUアルゴリズム、`run/accept`とsource cache、Before import基準は維持する。stand-inの`Rendered.frame=None`は実geometryの証拠にしない。Beforeはnative `before_settings()`がcrop／orientationだけを現在値に揃え、Afterの手動歪曲補正等を転写しない。hash64はnativeの既存settings hashであり、画像checksumや暗号学的出自証明として扱わない。

## 再現可能な準備・ビルド

1. 本家から上記commitの**未変更**checkoutを用意する。既存の利用者変更をreset／上書きしない。作業前にHEAD・statusを確認する。
2. GenzoRoomのリポジトリPythonから準備scriptを実行する（PowerShell例、`$source`は専用checkoutの絶対path）。

```powershell
$source = 'I:\code\raw-test\lightcraft-v0.10.0-gpu-poc'
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

現行GenzoRoomはLightCraftをinstallerに同梱せず、`GENZOROOM_LIGHTCRAFT_EXE`で外部の絶対pathを指定する構成。開発用にも上記scriptでbuild・検証したbinaryを指定する。汎用のTauri開発buildそのものにLightCraftを新たに同梱したり、自動download／本家更新を追加したりしない。

`desktop/packaging/build.ps1`は`-LightCraftExe`または`GENZOROOM_LIGHTCRAFT_EXE`が指定されている場合、packaging開始前に`--binary`を必須実行する。失敗時は配布buildを続行しない。未設定の場合は従来の外部engineなしbuildが可能で、RAW Before対応binaryを含む配布とは扱わない。将来MCPを同梱する場合は、この検証済みbinaryとreceiptを一組としてstageし、bundle検証でも同じ`--binary`を実行する。未検証ファイルを直接copyする経路を作らない。

runtimeはMCPの`render_preview.inputSchema.properties.before.type == boolean`を世代ごとに調べ、Before応答の`kind`、native import fingerprint、geometry、PNG実寸を検証する。schema非対応やBefore基準を確認できないbinaryでは`beforeKey=null`とし比較操作を無効にする。After／RAW編集は従来どおり利用できる。対応schemaだけを持ち、AfterをBeforeとして返すbinaryは画像検証で拒否し、Beforeだけを失敗にする。runtimeのSHA-256診断とbuild receiptで未変更本家binaryと管理buildを識別する。全配布先で既知hashの登録を強制する方式には変更しない。

A2導入時点はnative契約までで、A3でGenzoRoom runtime／HTTP／Frontendの品質・geometry capability／strict metadata／schedulerを接続した。現在はA5-P2のoptional executionとcapacity計量にも対応し、旧metadata互換経路を維持する。領域描画、最終解像度・容量・timeout・cache採用、実RAWのCPU/GPU性能・peak memoryは別の受入であり、synthetic probe成功と混同しない。

## 将来のエンジン更新

1. 新version／commitと上流の変更・ライセンス・設定schema互換性を調査する。先に現行固定値を置き換えて配布しない。
2. 専用の新clean checkoutに対してpatchの`git apply --check`を実行する。衝突する場合は`tools.rs`→`ui.render`→headless→native render jobの接続とmetadata契約を確認し、差分を調整する。本家の現像式は独自に移植しない。
3. 新commit基準のGit patch、manifestの対象commit／version／digest／変更対象を同じ変更で更新する。未対応の余分なdiffを承認しない。
4. 上記scriptでnativeテスト・CLI build・実binary Before／After probeを実施する。旧After省略契約、import基準、crop／orientation、Before失敗時のAfter継続を検証する。
5. GenzoRoomのadapter／runtime／Windows RAW API／復元／History・Reset、Frontend RAW API／hook／Viewer／JPEG比較・ショートカットの関連回帰、typecheck／production build／Python構文検査を行う。engine tupleと保存済みRecipeの互換性・非互換時の保持方針を再確認する。
6. 実RAW／GPU／WebViewの比較、zoom／pan、再入場／再生成、エラー回復を確認し、実機未実施範囲を明記する。検証後にadapter固定tuple、manifest、研究／architecture文書を一括更新する。新receiptを発行し、配布対象の実binaryを再検査する。

## 上流に同等機能が入った場合

独自patchを削除する前に、上流binaryのboolean Before schema、import基準、kind・fingerprint・geometry、PNG／After互換性を同じnative／GenzoRoom回帰とbinary probeで確認する。契約名が異なる場合は最小のadapter変換で同じ保証を満たし、画像種別を推測しない。互換性確認後、manifestの`patches`を空にしてpatchを削除し、nativeの機能テストが上流側にあるかGenzoRoom管理のprobeで代替されることを記録する。clean upstream buildでも`--build`／`--binary`検証とreceiptを維持する。patch不在を理由に能力検査を省かない。


## C1 Region検証の追加（2026-10-25）

固定upstreamは変更しない。同じ管理patchに `region.rs` とtests、C0のschema/contract/fixture artifactを含める。prepareはNative artifactがFrontend正本と一致すること、およびBackend schemaの一致を確認し、不一致ならbuildを中止する。既存Before/Whole tool schemaを拡張せず、独立 `render_region_preview` の `region_contract:1` を検出する。

`--build` は従来の全MCP試験・release build・B1 probeに続けて `region_probe.py` を実行し、成功後のみRegion contract入りreceiptを発行する。`--binary` も同じ実probeを行う。CPUと独立DX12 processで実Plan、Full/Draft、Before baseline、cache OFF/ON/tiny拒否後継続、Whole→Region→Whole、unknown schema/operation/version/oversized拒否、高entropy PNG、Full source選択、settings不変を確認する。GPU adapter不在は明示skipとする。このWindows実測ではDX12を実行した。probeはBackendのmethod-aware bounded transport/validatorを利用するため、repository Python環境とPillowが必要。

C1 EXE：`I:\code\genzoroom\.tmp\lightcraft-c1\target\release\lightcraft-cli.exe`、SHA-256 `2c7b7f01e366c56151dedffa0fc2b2af3496a035e3bba5a384a3fdcc1ac26812`。patch digest `e00ef2754b072076c54da746f145d7edbd87b331fa557f9ca38fd9b5948cc26e`。隣接receiptのupstream commit/digest/SHAとbefore/preview/region各contract1を実ファイルへ照合する。旧B1 EXE/receiptは変更せず残す。

C1初期Region budgetはPNG9 MiB / line13 MiB / metadata16 KiB / 2048軸・2,097,152 pixels。Whole17 MiB / 24 MiBとは分離する。実entropy PNG6,293,375 bytesの転送と超過拒否の境界試験を実施した。source/StagePool capacityをRSS/VRAMと混同しない。DehazeのWhole proxy由来差、実RAW memory peak、overlayの実機画質は別受入。詳細は[Region設計§12](RAW_REGION_PREVIEW_DESIGN.md#12-c1完了region-nativebackend2026-10-25)。現在のViewerはWholeのままで、C1 binaryの検証成功はC2の有効化を意味しない。
