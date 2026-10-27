# Phase 6A 基本エフェクト: 実装・検証結果

2026-10-27 / `feature/lightcraft-integration`。調査開始HEAD: `e0c3c076ab4954ff512d0e7a34e43fb825d9c887`。

**3項目の編集基盤への接続は実装済み。画質受入は未完了。** 合成素材の同一grid比較でcontext16のWhole/Region差が最大64 LSBとなり、かすみの除去はcontext256でも最大10〜11 LSB残った。これを許容できる微差とは判断しない。Native patch、scheduler、context、安全上限を変更して問題を隠す対応は行っていない。

## 実装した契約

* RAW UI順: カラー→基本補正→**エフェクト / Effects**→ディテール。エフェクト上部は折りたたみとON/OFFのみ。「基本エフェクト / Basic Effects」の小見出しにReset、下にテクスチャ・明瞭度・かすみの除去。周辺光量補正・粒子のUIは追加していない。
* control ID / JSON path: `effects.texture`、`effects.clarity`、`effects.dehaze`。各-100..100、step1、表示小数0桁、Reset0。既存`develop.set`、`AdjustmentSlider`、gesture境界を再利用。
* ON/OFF: `develop.sectionEnabled {section:"effects",enabled:...}`。Native本来の効果範囲を維持し、非公開vignette/grainにも作用。全設定値は保持。
* サブカテゴリReset: `develop.resetSection {section:"effects"}`の**1コマンドだけ**。3数値を0にし、vignette全数値/style、grain全数値/seed、disabled_sections、他カテゴリを保持。最終readbackを全settings比較で検証し、副作用・不正型・Reset漏れは拒否して既存rollbackへ送る。3 sectionの複合Resetは追加していない。
* History/Recipe: 既存のgesture単位保存、個別Reset、sectionToggle/sectionReset、Undo/Redo/Jump、no-op、redo枝切捨て、saveId retry、全settings保存・再open、Native再生成を使用。DB migration、settings version、512KiB応答上限の変更なし。Historyはカテゴリtoggleを「エフェクト」、sectionResetを「基本エフェクト」と区別し、3数値の差分を表示。
* RAWサブカテゴリheaderの縦/横フォーカスと数値入力中のReset境界を追加。`adjustmentSliderIds.ts`は既にRAW_CONTROL_IDSを動的に含むため変更不要。JPEGカテゴリ構成・Recipe schema・shortcut bindingは変更していない。

## Nativeと限定probeの条件

固定版はLightCraft `0.14.0`、commit `03c88c166c054c009db2a47187d59991f6232b85`。実EXEのSHA-256は`b872315ccd11c5c2e945f473d8ca48022127a4cc196b95d16ff3d8fb75004251`。既存artifact receiptとmanifest tupleを照合してから使用した。Native build/patch変更なし。

再現コマンド: リポジトリPythonで `native/lightcraft/effects_probe.py --json-out docs/research/lightcraft/PHASE6A_EFFECTS_RESULTS.json`。既存MCP・Region validator・child environment・artifact verificationを使用する。完全な各条件の測定値は[JSON記録](PHASE6A_EFFECTS_RESULTS.json)に保存。

* 素材は**合成RGB PNG**。1024×768の階調・周期texture・矩形境界を生成し、2048×1536へbicubic拡大してからimport。カメラRAW、RAW decode、実RAW性能の検証ではない。
* 各単独を-100/-40/+40/+100、3項目全+100/全-100、3項目70＋シャープ150＋輝度NR100＋カラーNR100、neutralの16ケース。
* 全ケースはvirtual full 1024×768、最大正補正3ケースは2048×1536も比較。後者が合成素材の100% grid。全ケース・両符号・全組合せを高解像度実RAW100%で検証したという意味ではない。
* 各gridでDraft/Fullを別々に要求し、**同じbackend/quality/settings/gridのWhole cropとRegion**を比較。中央・四隅・左画像端・中央から13px/7pxずらしたPan位置。比較ROIは384×288。prefetch0、context16。中央/Panの一部最大値ケースはcontext64/256も測定。診断要求だけを変え、アプリのcontext16を変更していない。
* validRegionはNativeの画像端契約に合わせて要求。context拡大でvalidRegionが画像端へ広がる場合も、比較ROIは同じ位置の同じ384×288を保持。各ROIと48px内側についてmax/mean、p50/p95/p99、1/3/8 LSB超のchannel割合を記録。割合は画素数ではなくRGB channel数が分母。
* CPUは`cpu_not_tried`（GPUを試さずCPU）、DX12は全描画で`gpu_success`を検証。adapter存在だけでGPU成功とは扱わない。Whole/Region比較は合計644条件。
* 全controlの実Native readback、3項目それぞれの`resetControl`、Effects eyeのOFF/ONと画素復帰、非公開vignette/grainを持つ`resetSection effects`の全settings保持比較も成功。

## 画質結果

下表はCPU、Full、context16。max列は該当条件群の最大channel差、meanはその最大差が出たROIの平均（全ROIの最大meanとは異なる）。DX12でもほぼ同じWhole/Region差を観測した。

| 設定 | grid / 位置 | max LSB | mean LSB | p95 / p99 LSB | 3 LSB超割合 |
|---|---|---:|---:|---|---:|
| neutral | 1024 / 中央 | 0 | 0 | 0 / 0 | 0% |
| texture -100 | 1024 / 中央 | 1 | 0.000112 | 0 / 0 | 0% |
| texture +100 | 1024 / 中央 | 1 | 0.000124 | 0 / 0 | 0% |
| clarity -100 | 1024 / 中央 | 6 | 0.146578 | 1 / 3 | 0.7617% |
| clarity +100 | 1024 / 中央 | 6 | 0.146222 | 1 / 3 | 0.8943% |
| dehaze -100 | 1024 / 中央 | 1 | 0.048705 | 0 / 1 | 0% |
| dehaze +100 | 1024 / 中央 | 62 | 0.413740 | 1 / 9 | 2.2955% |
| 3項目全+100 | 1024 / 中央 | 64 | 0.484863 | 1 / 12 | 2.5710% |
| 3項目全-100 | 1024 / 中央 | 7 | 0.191741 | 1 / 4 | 1.2367% |
| 3項目70＋最大NR/シャープ | 1024 / 中央 | 10 | 0.254922 | 1 / 4 | 1.2870% |

代表値+40の最大差はtexture1、clarity3、dehaze2 LSB。正のdehaze最大値と複合最大値では局所的に大きい差があり、meanだけで合格とはしない。

### 余白不足、guided格子、airlightの切り分け

同じ中央ROIでのCPU/Full比較:

| 設定 / grid | context16 max / mean | context64 max / mean | context256 max / mean |
|---|---|---|---|
| clarity +100 / 1024 | 6 / 0.146222 | 1 / 0.000012 | 1 / 0.000018 |
| clarity +100 / 2048（100%） | 3 / 0.203722 | 1 / 0.008186 | 1 / 0.000036 |
| dehaze +100 / 1024 | 62 / 0.413740 | 10 / 0.131459 | 10 / 0.131468 |
| dehaze +100 / 2048（100%） | 54 / 0.369882 | 15 / 0.169054 | 11 / 0.164822 |

1. **filter支持幅不足**: 余白拡大でclarityの境界差は大幅減。2048 dehazeもmax54→11まで減る。`LC:crates/pipeline/src/local.rs::plane_sigmas`はclarity sigma=.012*ppl、dark sigma=.02*ppl。`raster/src/blur.rs`の3 box passやguidedの多段Gaussianを経由するので、sigmaだけを必要contextに読み替えない。内側48pxとの差の減り方もJSONに記録。
2. **guided filterの格子差**: `local::guided_fast`はwindow寸法に対してceil除算した低解像度planeを作り、resizeして係数を戻す。window origin/寸法で格子位相が変わりうる。Pan位置ではcontext256でもclarityのmax1/mean0.014070（1024）、max1/mean0.004286（2048）が残る。格子起因と整合するが、浮動小数点累積との差の寄与は個別に定量化していない。単にhaloを増やせば完全一致するとしない。
3. **airlight推定の違い**: `pipeline/src/lib.rs::plan`はRegionに`local::frame_airlight`の長辺384px以下の全体proxy値を固定し、Wholeはその出力gridのdark planeの`airlight_of`を使う。GPUも`plan.fixed_air`を使用する。1024 dehazeの内側平均はcontext16/64/256でも約0.149 LSBと残り、余白増加だけでは消えないことを実測。全体推定値の違いと整合する。今回airlight数値そのものをNativeから取り出して測定していないため、「残差の何%がairlight」との断定はしない。NR併用時はproxyがNR前、Whole darkがNR後であることにも注意する。

**CPU/DX12間のWhole Full差**は16ケースすべてmax1 LSB以下。最大meanはNR/シャープ併用の0.000226 LSB。今回の大きいRegion差をDX12だけの不具合とは判断しない。

**同gridのWhole Draft/Full**は今回の19条件×2backendですべて画素一致。cache off、合成RGB、Light補正なし等に限った結果であり、RAW source level切替、tone base、NR変更中のDraft cache近似まで一致を保証するものではない。

## 性能（限定観測）

3項目各70、Whole1536×1152、Region416×320（valid384×288）、Full、stage cache ONの初回/同要求反復:

| backend | Whole stage-cold / warm | Region stage-cold / warm |
|---|---:|---:|
| CPU | 183.187 / 147.306 ms | 40.749 / 22.942 ms |
| DX12 | 124.475 / 107.572 ms | 32.553 / 19.684 ms |

各1sample。Stage coldはそのgeometry/寸法のstage entryがない状態であり、process冷起動・source cold decodeではない。request時間にはMCP・転送・PNG decodeが含まれる。Whole/Regionともcache反復時の画像一致を確認。RAW、UI表示採用時間、RSS/VRAM、高画素RAWのcold decodeは未測定。この値から実RAW性能やDX12高速化率を結論しない。性能目的のscheduler/cache最適化は行っていない。

## 自動検証・残存テストFinding

* Backend Python 3.14.5、リポジトリ`.venv`、backend cwdでfocused **422 passed**。対象はeffects/controls/detail/category、history API/store、recipe store/restore、Native adapter、smoke unit。追加した非公開control拒否を含む最終Effects単独は**16 passed**（前記と12件重複、追加4件）。新機能固有に未解決のテスト失敗はない。
* Frontend focused **12 files / 431 passed**。RAW UI/History/transport/controls/save/renewal、共通focus/navigation、JPEG pipeline、shortcut表示・matchingを含む。最終focus追補後の追加5ファイル検証は**301 passed / 4 failed**。RAW UI、navigation、editingは成功。
* JPEG追加検証の4失敗は、`AnshitsuClipboard.test.tsx`の3WAY Reset記号3ケース（期待`↺`、実ソース`竊ｺ`）と、`AnshitsuPage.test.tsx`のSSR Fitケース（`ImageViewer.tsx:90`の`window`参照）。4ケースに絞って再現し、**変更前HEADのFrontendを`.tmp/phase6a-baseline`へarchiveしたコピーでも同じ4失敗を確認**。今回のRAW追加で発生した回帰ではなく、未変更の既存Findingとして残す。JPEG UIをこのタスクで修正していない。絞込実行の157 skippedは対象外ケースであり、成功数には数えない。
* 型チェック `tsc --noEmit`を含む`npm run build`は最終コードで成功。Viteの500kB超chunk警告あり。code split等の無関係な最適化は行わない。
* `native/lightcraft/raw_preview_smoke.py`はPASS。Native readiness/artifactと、既存fixtureによる代表Viewer lifecycle・recipe restore・RAW resetを含む。ブラウザや実RAWでの手動確認ではない。
* 最大200件のHistory一覧を実HTTP APIで取得し、全20項目が高精度差分を持つ場合に**344,086 bytes**。snapshot非公開、512KiB以内。Frontendの全20差分transport受入・超過拒否も成功。上限変更なし。
* 通常sandboxではpytestの一時ディレクトリとVite一時moduleにアクセス問題があったため、同じ環境・コマンドをprivileged executionで検証した。通常sandboxの失敗を製品テスト成功には数えない。
* 全suite、Docker release Smoke、NAS/Firefox、ブラウザ手動検証は行っていない。変更範囲のfocused検証を使用。`git diff --check`を実行する。

## 修正方針とPhase 6Aの扱い

画質受入を完了するには、以下を別途判断する必要がある。今回の禁止範囲であるNative patch変更を独断で行わず、接続実装と測定結果をreview可能な状態で残す。

1. **Native側でWhole/Regionのairlight算出を同じ基準へ揃える案を優先して設計する。** 同settingsでview依存の明るさが変わる問題に対処できる。Wholeの既存画質維持か、共通proxyへの変更かで画質互換性と負荷が異なるため、既存Recipeの見え方への影響を評価する。GPUにも同じfixed値を渡す。今回の計測だけで変更方式を確定しない。
2. **空間filterの支持幅とglobal格子を扱う。** texture/clarity/dehaze＋NRの段数を含む余白またはNative work window設計と、guided低解像度planeのglobal origin整合を検討する。context256の一律採用はメモリ/性能費用があり、airlight残差も直らないので推奨しない。
3. **暫定策が必要ならEffects有効時にRegionを避けWhole表示へ限定する案**を検討する。ただし高密度100%表示、解像度上限、操作負荷の劣化を明示する必要があり、現行schedulerへ無断追加していない。Native修正の代替として同等画質と称さない。
4. 修正後に今回の同grid/quality/backend比較を再実行し、実RAW素材が提供された段階で高画素100%・crop/flip/straighten・Pan境界と実機表示を受け入れる。今回の中央/四隅/edge試験だけで任意RAWに一般化しない。

**現時点は「3項目の接続と自動検証済み、Region画質Findingのため受入保留」。Phase 6Aの画質完了とは報告しない。**

## 変更ファイル

* Backend: `backend/raw_controls.py`、`backend/lightcraft_raw.py`、`backend/raw_recipe_store.py`。
* Backend tests: `backend/tests/test_lightcraft_raw.py`、`test_raw_category_operations.py`、`test_raw_detail_controls.py`、新規`test_raw_effects_controls.py`。
* Frontend: `frontend/src/rawApi.ts`、`RawAdjustmentControls.tsx`、`RawEditHistory.tsx`、`adjustmentFocus.ts`、`adjustmentNavigation.ts`、`style.css`、`locales/ja.json`、`locales/en.json`。
* Frontend tests/fixture: `frontend/src/AnshitsuRawPreview.test.tsx`、`RawEditHistory.test.tsx`、`rawApi.test.ts`、`useRawDocument.test.tsx`、`test/rawSettings.ts`。
* 診断/結果: `native/lightcraft/effects_probe.py`、本書、`PHASE6A_EFFECTS_RESULTS.json`。

`windows_raw_api.py`は既存のeffects prefix抽出とsection操作経路をそのまま使用でき、変更不要。`AdjustmentSlider.tsx`も既存gesture契約をそのまま使用。README/CHANGELOG/architecture/development-notes、Native patch/manifestは変更していない。
