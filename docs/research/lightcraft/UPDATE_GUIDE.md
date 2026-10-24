# LightCraft 更新・GenzoRoomパッチ管理

この手順は開発用・配布用のどちらのLightCraftにも適用する。現在の本家基準は **v0.10.0 / `a2a41383c4fd62fa85a46ccd00998639221f2d3c`**。C4-Dで本家versionは変更していない。固定値とパッチdigestの正本は [`native/lightcraft/manifest.json`](../../../native/lightcraft/manifest.json)。独自変更は本家commitに含めず、同directoryのGit patchとして保存する。patchはfull-index形式とし、`.gitattributes`でLFを固定してWindows checkoutでもdigestを維持する。

## 管理対象

| パッチ | 目的・変更対象 |
|---|---|
| `0001-native-before.patch` | MCPのBefore＋adaptive品質・frame・StageCache契約。pipeline/GPUの実Plan sidecarとbuffer計量、Engine/stand-inの戻り値追随、MCP/native fixtureを含む。全targets・digestはmanifestで管理 |

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

`--build`は検証後に`cargo test --locked -p lightcraft-mcp -- --test-threads=1`、`cargo build --release --locked --no-default-features -p lightcraft-cli`を実行し、**生成したbinary自身**へMCP handshake／tools schema／synthetic PNG import／Beforeと省略時Afterのrenderを要求する。A2 probeはAfter/Beforeそれぞれの明示Draft/Full、品質省略＋契約1のFull、legacy metadataの完全形状、geometryId/native寸法/実PNG寸法、cache off/on/tiny budget、最終Fullの画像一致・settings不変と、不正quality/contract/cache引数の固定code拒否も検査する。成功時だけ隣接する`lightcraft-cli.genzoroom.json`を生成する。receiptはversion／本家commit／patch digest一覧／binary SHA-256／`beforeContract:1`／`previewContract:1`を持つ。旧Before receiptだけではA2対応と認定しない。全工程は非zero exitで中止し、receiptを成功前に発行しない。

binaryの差替え検出には`--binary`を使う。現在のmanifest、receiptと実ファイルのSHA-256を一致確認した後、実binaryのschemaとrenderを再検査する。version文字列だけ、古いreceiptだけ、patchを適用したsourceだけではbinaryを承認しない。receiptは署名済みサプライチェーン証明ではなく、管理されたbuildとローカルファイルの照合記録である。

A5-P0以降のprobeは、追加でGPUを無効化し、CPUの1024px要求／512 MiBでcacheが適用・保持されること、反復とBefore/After、off/on Full PNG一致、settings不変、off切替時の解放を実binaryで確認する。CPU admissionは実sourceと既存bufferの容量・追加確保分から計算し、GPU／混在／情報不足は従来の安全側見積りを維持する。probeは合成PNGの契約検証であり、実RAWの性能・RSS／VRAM受入を代替しない。

## 開発・Windows配布との接続

現行GenzoRoomはLightCraftをinstallerに同梱せず、`GENZOROOM_LIGHTCRAFT_EXE`で外部の絶対pathを指定する構成。開発用にも上記scriptでbuild・検証したbinaryを指定する。汎用のTauri開発buildそのものにLightCraftを新たに同梱したり、自動download／本家更新を追加したりしない。

`desktop/packaging/build.ps1`は`-LightCraftExe`または`GENZOROOM_LIGHTCRAFT_EXE`が指定されている場合、packaging開始前に`--binary`を必須実行する。失敗時は配布buildを続行しない。未設定の場合は従来の外部engineなしbuildが可能で、RAW Before対応binaryを含む配布とは扱わない。将来MCPを同梱する場合は、この検証済みbinaryとreceiptを一組としてstageし、bundle検証でも同じ`--binary`を実行する。未検証ファイルを直接copyする経路を作らない。

runtimeはMCPの`render_preview.inputSchema.properties.before.type == boolean`を世代ごとに調べ、Before応答の`kind`、native import fingerprint、geometry、PNG実寸を検証する。schema非対応やBefore基準を確認できないbinaryでは`beforeKey=null`とし比較操作を無効にする。After／RAW編集は従来どおり利用できる。対応schemaだけを持ち、AfterをBeforeとして返すbinaryは画像検証で拒否し、Beforeだけを失敗にする。runtimeのSHA-256診断とbuild receiptで未変更本家binaryと管理buildを識別する。全配布先で既知hashの登録を強制する方式には変更しない。

A2はnative契約までで、GenzoRoom runtime／HTTP／Frontendはまだadaptive引数を送らない。現行runtimeは旧metadata互換経路を利用する。A3で初めて新品質・geometryのcapability／strict metadata／schedulerを接続する。領域描画、最終解像度・容量・timeout・cache採用、実RAWのCPU/GPU性能・peak memoryは別の受入であり、synthetic probe成功と混同しない。

## 将来のエンジン更新

1. 新version／commitと上流の変更・ライセンス・設定schema互換性を調査する。先に現行固定値を置き換えて配布しない。
2. 専用の新clean checkoutに対してpatchの`git apply --check`を実行する。衝突する場合は`tools.rs`→`ui.render`→headless→native render jobの接続とmetadata契約を確認し、差分を調整する。本家の現像式は独自に移植しない。
3. 新commit基準のGit patch、manifestの対象commit／version／digest／変更対象を同じ変更で更新する。未対応の余分なdiffを承認しない。
4. 上記scriptでnativeテスト・CLI build・実binary Before／After probeを実施する。旧After省略契約、import基準、crop／orientation、Before失敗時のAfter継続を検証する。
5. GenzoRoomのadapter／runtime／Windows RAW API／復元／History・Reset、Frontend RAW API／hook／Viewer／JPEG比較・ショートカットの関連回帰、typecheck／production build／Python構文検査を行う。engine tupleと保存済みRecipeの互換性・非互換時の保持方針を再確認する。
6. 実RAW／GPU／WebViewの比較、zoom／pan、再入場／再生成、エラー回復を確認し、実機未実施範囲を明記する。検証後にadapter固定tuple、manifest、研究／architecture文書を一括更新する。新receiptを発行し、配布対象の実binaryを再検査する。

## 上流に同等機能が入った場合

独自patchを削除する前に、上流binaryのboolean Before schema、import基準、kind・fingerprint・geometry、PNG／After互換性を同じnative／GenzoRoom回帰とbinary probeで確認する。契約名が異なる場合は最小のadapter変換で同じ保証を満たし、画像種別を推測しない。互換性確認後、manifestの`patches`を空にしてpatchを削除し、nativeの機能テストが上流側にあるかGenzoRoom管理のprobeで代替されることを記録する。clean upstream buildでも`--build`／`--binary`検証とreceiptを維持する。patch不在を理由に能力検査を省かない。
