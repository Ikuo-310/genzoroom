# LightCraft v0.14.0 Effects 統合事前調査（Phase 6）

調査日: 2026-10-27。対象: Windows Native GenzoRoom、`feature/lightcraft-integration`。本変更は調査・設計のみであり、機能実装、Native更新、DB変更は行わない。

## 1. 結論と証拠の範囲

対象の**数値11項目すべてがCPU/DX12の描画へ接続されている**。Phase 4・5の未接続Detail項目のような、保存されるだけの数値項目は今回の対象には見つからなかった。ただし、周辺光量補正の3モードが常に異なる画を生成するわけではない。負補正の「カラー」と「描画」は同じ黒への乗算になり、正補正は3モードとも同じ式。「ハイライト」モードのHighlightsは負補正時だけ働く。この制約を直すためのNative改修は、LightCraft既存挙動の接続とは別の仕様変更になる。

通常スライダーはA、モード選択はB。カテゴリResetはNativeの3 sectionをGenzoRoomの1操作へまとめる必要がある。描画機能を新規実装するCや除外Dは現時点では推奨しない。ただし、**context=16でのWhole/Region一致は採用条件として別途検証が必要**。明瞭度・かすみの除去の参照幅は16pxを大きく超え、airlightやguided filterの格子にも差がありうるため、全機能を一括で「画質整合性確認済み」として完成扱いにはしない。

| 対象 | 確認した固定情報 |
|---|---|
| GenzoRoom調査開始HEAD | `cc17a76464d60ab1d6f4096cb0d33a03a90a0bd3`、開始時変更なし、対象ブランチ一致 |
| LightCraft version / commit | `0.14.0` / `03c88c166c054c009db2a47187d59991f6232b85`。`native/lightcraft/manifest.json`と実checkout HEADを照合 |
| 読んだNative checkout | `.tmp/lightcraft-0.14`。管理patch適用済みでありclean upstreamとは区別する |
| 管理patch | `native/lightcraft/patches/0002-v0.14-native-contracts.patch`。実SHA-256 `9308d0663de3e4d1f6fd65e564fb04cc7ac1c993b5c1a2aae29ef1f72b521063`、manifestと一致 |
| 契約 | settings schema 1、Before/Preview/Region/WB契約1、geometry descriptor 2 |
| 証拠 | 下記の実ソース、既存テストの内容、§8の限定probe。添付画像は対象UIの参照であり描画実装の証拠にはしない |

以下の`LC:`はこのcheckoutからの相対パス、`GR:`はGenzoRoomからの相対パス。関数名・構造体名を追跡点とする。主要な`develop/src/settings.rs`、`controls.rs`、`lib.rs`、`pipeline/src/local.rs`、`finish.rs`、`gpu/src/params.rs`、`gpu/src/wgsl/finish.wgsl`、`ui-egui/src/panels/edit.rs`は管理patchの変更対象ではない。Region座標、preview実行・診断経路はpatch適用後のソースを調べた。

## 2. 全パラメーター仕様

正本: `LC:crates/develop/src/controls.rs`の`CONTROLS`、`settings.rs`の`Effects`、`Vignette`、`VignetteStyle`、`Grain`と各`Default`。数値のJSON型はnumber、Rustではf64。全数値のUI stepは1、表示小数桁は0。stepはUIの刻みであり、`controls::set`は範囲clampを行うだけで整数丸めを強制しない。`DevelopSettings::merged`もcontrol範囲へclampする。

「カテゴリReset」列はNative `develop.resetSection`でその値を変更するsection。GenzoRoomの統合カテゴリReset案は§5を参照。RAWの`for_raw`はDetail/WBだけを変えるので、Effectsの組込み初期値は以下と同じ。ただしimport preset/lookによる初期値上書きは別であり、全Resetはそのimport lookへ戻ることがある。

| 日本語 | Native control ID | settings JSON path | 値域 | 初期値 | 単項目Reset | カテゴリReset後の値 / section | 判定 |
|---|---|---|---|---|---|---|---|
| テクスチャ | `effects.texture` | `effects.texture` | -100..100 | 0 | 0 | 0 / `effects` | A |
| 明瞭度 | `effects.clarity` | `effects.clarity` | -100..100 | 0 | 0 | 0 / `effects` | A |
| かすみの除去 | `effects.dehaze` | `effects.dehaze` | -100..100 | 0 | 0 | 0 / `effects` | A |
| 周辺光量補正量 | `vignette.amount` | `vignette.amount` | -100..100 | 0 | 0 | 0 / `vignette` | A |
| 中心点 | `vignette.midpoint` | `vignette.midpoint` | 0..100 | 50 | 50 | 50 / `vignette` | A |
| ぼかし | `vignette.feather` | `vignette.feather` | 0..100 | 50 | 50 | 50 / `vignette` | A |
| 丸み | `vignette.roundness` | `vignette.roundness` | -100..100 | 0 | 0 | 0 / `vignette` | A |
| ハイライト | `vignette.highlights` | `vignette.highlights` | 0..100 | 0 | 0 | 0 / `vignette` | A（作用条件あり） |
| 粒子量 | `grain.amount` | `grain.amount` | 0..100 | 0 | 0 | 0 / `grain` | A |
| サイズ | `grain.size` | `grain.size` | 0..100 | 25 | 25 | 25 / `grain` | A |
| 粗さ | `grain.roughness` | `grain.roughness` | 0..100 | 50 | 50 | 50 / `grain` | A |

追加の非スライダー値:

| 値 | Native ID / JSON型 | 値域・初期値 | Reset / API |
|---|---|---|---|
| 周辺光量補正モード | 数値control IDなし。UI widget IDは`vignetteStyle`。JSON `vignette.style`: string | `highlightPriority`（初期値）、`colorPriority`、`paintOverlay` | `develop.merge`で変更。`resetControl`不可。`resetSection`では保持 |
| 粒子seed（非公開UI） | 数値control IDなし。JSON `grain.seed`: integer / Rust u32 | 0..4294967295、初期値0 | `develop.merge`で変更可能、範囲外・不正型はserde失敗。`resetControl`不可、`resetSection`では保持 |

モード・seedにUI step/表示精度は適用しない。「中心点」は効果開始半径の調整であり、中心XYを移動する機能ではない。XY controlは存在しない。添付画像と同じ11スライダー＋モードだけを公開し、seedや独自XY操作は追加しない。

### 公開設定API

正本: `LC:crates/engine/src/cmd/develop.rs`の`specs`、`edit`。

* 数値: `develop.set {control,value}`または`{values:{controlId:number}}`、`develop.adjust {control,delta}`、`develop.resetControl {control}`が全11項目で使用可能。
* JSON: `develop.merge {settings:{...},label?}`で数値、style、seedを操作可能。`get_develop`で全settingsを取得する。`develop.set`に`vignette.style`や`grain.seed`を渡してもcontrol登録がないため失敗する。
* モード変更用の独立した専用コマンドはない。Native UI自身が`develop.merge {settings:{vignette:{style:"colorPriority"}}}`を使用する。
* 依存スライダーやカテゴリOFFのUI条件は設定APIの書込み禁止条件ではない。OFF中にもAPIから保存値を更新できる。値域内でも常に画素差が出るとは限らない。

## 3. Native描画接続

共通入口は`LC:crates/pipeline/src/lib.rs`の`plan`、`render_cached`、`local::prepare`、`finish::FinishParams::new`。GPUは`LC:crates/gpu/src/render.rs`の`render`、`prepare`から共通`FinishParams`を作り、`params.rs::finish_block`でshader引数へ詰める。最終式は`pipeline/src/finish.rs::finish_with`と`gpu/src/wgsl/finish.wgsl`の対応する処理。

| 機能 | CPUの実接続 | DX12の実接続 | 性質 |
|---|---|---|---|
| テクスチャ | `local::plane_sigmas/prepare`の`texture_blur`、finishでlog輝度とblurの差に`tex`を乗せる | `render.rs::prepare`のtexture、paramsのTEX、finish shaderのtexture項 | シャープとfine planeを共有。量の符号で加減 |
| 明瞭度 | guided filterの`clarity_blur`、finishで`clar`とmid-tone weightを掛ける | GPU guided filter、CLAR、対応shader式 | 広い輝度帯域とtone baseに依存 |
| かすみの除去 | RGB最小channelのblur、airlight、finishの`dz`分岐 | dark kernel＋Gaussian、CPU percentile readback、shader dehaze | 正負で別式。全体airlightにも依存 |
| 周辺光量補正5数値＋style | `finish::vignette`→`Vig`→finishのpost-crop vignette | paramsのVIG各値・STYLE、finish shader | 全体座標、各画素の輝度、モード条件 |
| 粒子3数値＋seed | `FinishParams::new`→grain tuple、`grain_noise`→encode後加算 | GRAIN各値・AFF・SEED、shader `grain_noise` | 決定論的な座標hash、時刻乱数なし |

上の接続は単なるUI存在の確認ではなく、settings→plane/params→最終画素式まで追跡した結果。未接続の数値はないが、§4の条件付き無作用を隠さない。

## 4. 周辺光量補正と粒子の操作契約

### 4.1 3モードの実際の違い

Native UI: `LC:crates/ui-egui/src/panels/edit.rs::show`内のEffects section（`styles`配列）。enumのcamelCase serdeと一致する。

| 表示（日本語 / 英語） | JSON | GPU内部値 | 負補正時 |
|---|---|---|---|
| ハイライト / Highlight | `highlightPriority` | 1 | `f=1+amount*t`を、Highlightsと` smooth(0.4,1,lum)`で1側へ戻して乗算。明部保護 |
| カラー / Color | `colorPriority` | 0 | `d *= 1+amount*t` |
| 描画 / Paint | `paintOverlay` | 2 | `d = d*(1-(-amount)*t)+0`。上行と数学的に同じ |

ここでamountはUI値/100、tは周辺距離のsmooth weight、dはdisplay-linear色。Highlights=0ではハイライトモードも他の2つと同じ式になる。正補正は全style共通で`d += (1-d)*amount*t*0.85`。CPUのHDR分岐では`max(1-d,0)`にしてHDR明部を下げない。GPU shaderの正補正式にはこのmaxガードがない。`gpu::handles`はU8、device-proofなし、HdrRange overlay以外を許可し、HDR settingsだけで一律CPUへ落とす条件ではないため、HDR正補正はCPU/DX12差の候補となる（今回のSDR統合受入と区別し、HDR対応を含める場合は別途検証する）。モード名から独自の色保持演算や別の描画モデルを推定しない。

midpointは`start=.15+.95*midpoint/100`、featherは`width=.05+1.1*feather/100`。roundnessはaspect mixと距離のpowerを変える。指定範囲の中でもt=0の画素は変化しない。

### 4.2 Native UIとエンジンの条件を分離

| 条件 | Native UI (`panels/edit.rs`) | エンジン (`FinishParams::new` / `vignette`) | 保存値 |
|---|---|---|---|
| vignette.amount=0 | amount以外の4スライダーをdisabled。モード選択は有効 | `Vig=None`、全周辺光量効果なし | midpoint等とstyleを保持 |
| amount≠0へ戻す | 4スライダーを再有効化（符号不問） | `effects`がONならVig生成 | 以前の値で再開 |
| style変更 | amount=0でも選択可能。依存値をResetしない | style分岐だけ変化 | amount以下の全数値を保持 |
| highlights≠0でもColor/Paint、またはamount≥0 | amount≠0ならHighlights UIも有効 | Highlightsの値を参照する分岐に入らず無作用 | 値は保持しHighlight＋負補正で再び作用 |
| grain.amount=0 | size/roughnessをdisabled | grain tupleなし | size/roughness/seedを保持 |
| grain.amount>0へ戻す | size/roughnessを再有効化 | `effects`がONなら生成 | 以前の値で再開 |
| effectsカテゴリOFF | section headerのeyeのみ切替。`section()`はbody全体をdisabledにしない | global texture/clarity/dehaze=0、Vig/grain=None | 全設定を保持 |

Native UIのsection OFFは値の編集自体を禁止しない。一方、GenzoRoom既存UIはカテゴリOFFのスライダーを無効化している。そのGenzoRoom共通UXをEffectsにも適用してよいが、Nativeエンジンの制約とは記述を分ける。従属判定はdesired amountも使い、0への操作中にフォーカス確定・History境界を壊さない。無効化時に値を書き換えたり、一律defaultを送ったりしない。Nativeと合わせるならHighlightsにはmodeによる追加disabled条件を付けない。

### 4.3 粒子の再現性

`LC:crates/pipeline/src/finish.rs::grain_noise`はfloor座標とu32 seedを固定`GRAIN_HASH`でhashし、格子間をsmooth補間する。2つ目の周波数は2.3倍、seedは`seed ^ 0x55`。粗さは両者の混合量、量は最大0.13の振幅、サイズは`cell=max((.0006+.0024*size/100)*px_per_long,.6)`。加算はencode/curveの後で、同じノイズをRGBへ加える。振幅は元画像のencode後輝度にも依存する。

したがって**同じsettings・同じRAW・同じ出力grid/geometry・同じquality/cache条件・同じbackendで再現像すれば、粒子の乱数パターンは決定論的に再現される設計**。Preview要求回数、revision、時刻、process再起動をseedへ混ぜない。seedはdefault 0であり、「stable per photo」というコメントから写真ごとにランダム初期化されるとは解釈しない。調べたRust参照にはimport時にseedを書き替える処理はない。Recipe/Historyへseedを含む全settingsを保存する。

Whole/Regionは`Frame::out_to_norm`を通して同じoriented-image座標へ写すため、同じvirtual full gridの同じ画素なら同じパターンを参照する設計。単なるRegionローカルx/yの乱数ではない。crop/flip/straightenで座標対応が変われば見えるパターンも変わる。CPUはf64 affine結果をf32へ、GPUはf32 affine係数を先に作るので、backend間・window間の浮動小数点順序差までbit一致とは言えない。

解像度を変えた場合、cellの0.6px下限が効かない範囲では`px_per_long/cell`が相殺され、画像座標上の周波数は安定する。ただしサンプル位置と元輝度は変わる。小サイズ/低解像度で下限が効けば周波数自体も変わる。Wholeを拡大した画像と高密度Regionの画素完全一致は保証しない。Draft/Fullも同解像度・同じ入力planeならgrain式は共通だが、他補正・NR・cache近似が元輝度を変えれば最終粒子振幅が変わりうる。

## 5. エフェクトカテゴリON/OFF・Reset

**ON/OFFのNative section IDは`effects`**。`LC:ui-egui/src/panels/edit.rs`の`section(...,"effects","Effects",...)`、`pipeline/src/finish.rs::FinishParams::new`の`section_enabled("effects")`が根拠。`disabled_sections`配列へ保存する。ONは該当文字列を除去、OFFは重複を除いて追加する（`DevelopSettings::set_section_enabled`）。`vignette`/`grain`は数値controlのSection分類／Reset名であり、これらの文字列だけをdisabled_sectionsへ入れても、この3グループの描画OFFにはならない。

| 操作 | Native契約 | GenzoRoom統合案 |
|---|---|---|
| OFF→ON | `develop.sectionEnabled {section:"effects",enabled:bool}`。数値・style・seedは保持、復帰時再使用 | 既存`sectionToggle`を拡張、1 History step |
| `resetSection effects` | texture/clarity/dehazeだけdefaultへ | **これだけではGenzoRoomカテゴリ全体Resetにならない** |
| `resetSection vignette` | 5数値だけdefaultへ。style保持 | 下記の複合Resetに含む |
| `resetSection grain` | 3数値だけdefaultへ。seed保持 | 同上 |
| 単項目Reset | `CONTROLS` defaultへ。style/seed不可。disabled_sections保持 | 既存`controlReset`を再利用 |
| 全Reset | `develop.reset`はimport lookまたはcamera defaults、WB参照、最新processへ。全カテゴリ、style/seed、マスク等にも及ぶ | 既存GenzoRoom `allReset`はNative resetの後で元のdisabled_sectionsをmergeして保持する。これを変えない |

Native UIのEffects header自体にはカテゴリ一括Resetはない（`section`のcontext menuはSolo Mode）。Native設定APIには上記3種のResetがある。この2つを混同しない。

推奨するGenzoRoom EffectsカテゴリResetは、**3つの`develop.resetSection`を既存`_mutate(commands=...)`の中で実行し、1回の最終readback、1 revision、1永続History操作にまとめる**方式。数値11項目をdefaultへ戻し、style・seed・disabled_sectionsを保持する。Nativeのcontrol Reset契約を組み合わせる最小案であり、独自描画や新Nativeコマンドは不要。途中失敗時は既存restore/desync境界へ流し、部分Resetを成功として保存しない。

この案では「モードも初期化するReset」とは呼べない。モードまでdefaultへ戻す製品仕様を選ぶなら、同一mutation内で`develop.merge`に`vignette.style=highlightPriority`を追加し、expected readbackとテストを更新する必要がある。seedを0へ戻す必要は通常ない。初回実装ではNative同様に両方保持を推奨する。

他カテゴリへの直接のsettings書換えは不要。OFF/ONは配列だけ、複合Resetは対象11数値だけを変更し、Color/Light/Detail、AI NR、process、masks、optics等が不変であることを全settings比較で検証する。非公開seed/styleも不変。画像上ではtexture planeの共有、clarityのtone base依存、profileのeffective settings等により他補正との相互作用があるため、settings不変と画素不変は区別する。マスク内のtexture/clarity/dehazeは別のLocalAdjustmentsであり、Effects OFFがマスク全体を消す契約ではない。`plane_sigmas`はOFF中の保存global値からもplaneを確保しうるので、OFFで演算費用がすべて消えるとの性能保証も置かない。

## 6. GenzoRoomの再利用範囲と必要変更案

DBやsettings schemaの変更は不要。既に全Native settingsを保存し、UI未公開のvignette/style/grain/seedもsnapshotへ含まれる。既存データ互換だけの追加変換層は作らない。必要なのは公開allowlist・操作型・検証・表示の拡張。

| ファイル / 追跡点 | 再利用とPhase 6で必要な拡張 |
|---|---|
| `GR:backend/raw_controls.py`: `CONTROLS`, `CONTROL_PATHS`, `SECTIONS`, `controls_state`, `validate_history_operation` | 11数値と`effects`カテゴリを追加。今回のIDはJSON fieldと同名でsplit対応可能。styleは数値allowlistに混ぜずenum readback/検証を追加 |
| `GR:backend/lightcraft_raw.py`: `set_controls`, `_mutate`, `apply_history_operation`, `merge_settings`, `restore_persisted_settings` | 数値更新の直列化、revision、readback、失敗restoreを再利用。複合Effects Resetの専用expected設定を追加（現在の非Detail分岐はlight/color専用）。style変更を限定enumから`develop.merge`へ送り、style以外不変を照合 |
| `GR:backend/windows_raw_api.py`: `_history`, `_history_changes`, `_history_body`, `_history_checkpoint` | 既存保存barrier・checkpoint・retry・recoveryを再利用。`effects`のchanges対象はprefixだけでなくvignette/grainも含める。style用intentを追加しgeneric settings endpointへUIから直接書かない |
| `GR:backend/raw_recipe_store.py`: `_settings_json`, `_history_metadata`, `HISTORY_CONTROLS`, `HISTORY_SECTIONS`, `_save_history` | 全settings保存、CAS revision、saveId receipt、cursor移動、redo枝切捨てを維持。allowlist拡張とstyle operation metadata検証が必要。現テーブルのkind/metadata JSONで表現できDB migration不要 |
| `GR:frontend/src/rawApi.ts` | ID/section union、runtime validator、RawSettingsのstyle、operation/History型を追加。数値`RawValues`へ文字列を混ぜない |
| `GR:frontend/src/RawAdjustmentControls.tsx` | bindingsをColor→Basic→**Effects**→Detailとする。表示は「エフェクト」/「Effects」。既存RawCategory、2つの小見出し、11スライダーを再利用。従属disabled追加。モードだけ3択segmented/radio UIを追加 |
| `GR:frontend/src/AdjustmentSlider.tsx` | `commitPolicy="operation-boundary"`、pointer/keyboard/wheel/numberの開始終了、Resetとfocus調整をそのまま使用。新しい汎用スライダーは不要 |
| `GR:frontend/src/RawEditHistory.tsx` | 数値ラベル/formatter、Effectsカテゴリ名、mode変更の表示を追加。HistoryList自体の作り直し不要 |
| `GR:frontend/src/rawRecipeSave.ts`, `useRawDocument.ts` | `begin/change/end`、`operate`、Undo/Redo/jump、保存lock、Preview失敗と保存失敗の分離、stale result拒否を再利用。styleを既存操作キューへ追加 |
| focus/i18n関連 | `adjustmentSliderIds.ts`などの型・ナビゲーション登録、日英localeと対象テストを拡張。既存JPEGエフェクト処理へ値を転送しない |

### History境界とRecipe

* 数値ドラッグ開始=`beginControls(control)`、途中変更=`changeControls`、終了=`flushControls`。1 gestureで1step。数値入力、ホイール、キー操作の既存境界も維持する。11項目用の新History基盤は不要。
* モード選択は提案kind `vignetteStyle`、metadata `{style:"highlightPriority"|"colorPriority"|"paintOverlay"}`の離散操作1stepにする。変更前に`commitAdjustmentEdits`→既存saverの`operate`で直前gestureを確定。`control`の数値差分へ偽装しない。stepのsettings全体にstyleを保存し、一覧には選択後モードを表示すればよい。
* カテゴリtoggle、11項目の複合Resetもそれぞれ1step。Native内部で複数のHistory entryになっても、GenzoRoomのUndo/RedoはNative Historyを直接なぞらず、保存した全settingsのrestoreで処理する。mode/seedもsnapshotから戻る。
* `raw_recipe_store`の全settings JSONとHistory snapshot、settings fingerprint、Recipe revision、saveId冪等性、uncertain save retryを維持。mode追加でも列やデータversionを増やさない。
* reset/toggleの`_history_changes`とHistory表示は見た目の差分要約であり、永続snapshotの対象範囲を狭めない。modeだけ変わるstepを「数値差分なしだからno-op」と誤判定しない。settings fingerprintで判定する。
* Previewは既存desired→Native ACK→Draft/Full/Region更新へ流す。style操作もconfirmed revision更新後に描画し、前revisionの結果を採用しない。粒子seedをPreviewごとに再発行しない。

## 7. Whole/Region・Draft/Full・性能の課題

### 7.1 画素参照範囲

`LC:pipeline/src/local.rs::plane_sigmas`のpplはRegion幅ではなく`plan`が全出力から計算した`px_per_long`。cropなしなら全体長辺に相当し、crop時は元画像長辺単位へ換算される。

| 項目 | 参照 | context=16との関係 |
|---|---|---|
| テクスチャ | log輝度のGaussian近似、sigma=`max(.0018*ppl,.6)`。シャープと共有 | `LC:raster/src/blur.rs::gaussian/box_radii/radii_for`の3 box pass。各軸の支持幅は半径の合計。ppl=4096ならsigma約7.37で合計半径は約21pxとなり16を超える。NR等の前段分も別に必要 |
| 明瞭度 | `guided_fast`、sigma=`max(.012*ppl,1)`、CLARITY_EPS。tone baseによるmid weightも使用 | ppl=4096で約49px。guided係数は複数Gaussianを経由、単一sigmaだけをhalo扱いしない。subsample寸法`ceil(w/s)`と再拡大格子がwindowごとに異なり、halo増加だけでbit一致する保証もない |
| かすみの除去 | 最小RGBのGaussian、sigma=`max(.02*ppl,1)`＋airlight | ppl=4096で約82px、3 box合計は約244px。16pxで遮断される近傍が多い。airlightは非局所依存 |
| 周辺光量補正 | post-crop全体frameのview offset/幅/高さと画素輝度 | 自身の近傍halo不要。Region中心に再配置しない。前段の境界差は残る |
| 粒子 | oriented-image affine座標、seed、画素輝度 | 自身の近傍halo不要。乱数hashにRegion originを別seedとして足さない。前段の輝度差は粒子振幅にも伝播 |

かすみの除去はWholeで`airlight_of`（7画素ごとのsampleの99.5 percentile、下限.05）、Regionでは`plan::fixed_air`として**長辺384px以下の全体proxy**から求めたairlightをCPU/GPUとも使用する。Region内だけから求めない仕組みは既にあるが、Wholeの高解像度dark planeとproxy percentileは同一とは限らない。haloを十分増やしてもこの差は残りうる。`local::frame_proxy`にはsource/frame/size単位の4件cacheがある。かすみの除去がcold Region時に全体proxy生成を要することと、Regionの最終画素数による演算削減を分けて評価する。

`GR:frontend/src/rawRegionAuto.ts`はcontext16/prefetch64、手動経路`useRawDocument.ts`はcontext16/prefetch0。prefetchを常に十分なfilter支持幅として数えない。`LC:pipeline/src/lib.rs::plan`はspots用にはwork windowを拡大するが、Effectsの支持幅に応じたwindow拡大は行わない。Native契約にあるvalidRegionは、この範囲の画質一致を数学的に保証するものではない。

Phase 5で報告された最大NRの境界差は今回再測定していない。Effectsはその前段NRからの影響に加え、別の広い空間filterとairlight依存を追加する。特に「NR単独で許容したcontext16だからEffectsも安全」という判断はできない。

### 7.2 quality、CPU/DX12、cache

* `plane_sigmas`はEffects自身のsigmaをDraftで縮めない。一方、Lightのtone baseはDraftでsigma上限24px。明瞭度のmid weightはbaseを読むため、併用時の結果は変わりうる。
* CPU `render_cached`はNR変更時のDraftで`Planes::for_other_nr`によりwide planeを近似再利用し、log_l/fine textureを再生成する。Fullはこの近似を使わない。Effectsのみの変更、NR併用、cold/warmを分離して測る。
* GPUも`local::plane_sigmas`を参照し、texture/darkはGaussian、clarityはguided filterを計算。airlight percentileにはGPU→CPU readbackが入る。共通FinishParams＋shader式があり、CPU独自EffectsをGenzoRoomへ移植する必要はない。
* GPU経路は`LC:gpu/src/lib.rs::render`周辺の対応可否・失敗でCPUへfallbackしうる。計測ではadapter存在だけでなく既存execution metadataの`gpu_success`等を確認する。CPU/GPUのfloat演算順、guidedのresample、最終量子化に差があり、全画素bit一致を契約にしない。
* 数値量・style・seedはfinish中心の変更だが、0→非0で必要planeの新規確保も起こる。Effect OFFでも保存値からplane準備が残ることがある。StageCacheの有効無効・frame・解像度・NR/geometry失効を含めた実負荷は未計測であり、UI項目数から性能を断定しない。
* 同一RAW/settingsでもWhole Draft低密度とRegion Full高密度は、RAW source level、再sample、NR、filter格子、grain cell下限が異なる。同virtual full寸法・同qualityでのWhole crop比較と、ユーザーが見る異密度surface切替の見え方を別に評価する。

### 7.3 既存テストの根拠と限界

`LC:pipeline/src/tests_window.rs::the_vignette_belongs_to_the_frame_not_the_window`は周辺光量の全体座標を検証。`spatial_adjustments_agree_inside_the_halo`は明瞭度/かすみ/textureを含むが、960×640・halo64で、許容max6/mean0.8 LSB。context16や最大解像度への証明ではない。

`LC:gpu/tests/it/equivalence.rs::cases`にgrain、負/正dehaze、負clarity/texture、vignetteモード等があり、`banded_full_size_render_matches`には3000×2000のgrain＋vignette＋maskがある。通常の比較基準はmean<.5/max≤3 LSB、GPUなしでskip可能。**今回これらのRustテストは実行していない**。テスト存在と実行結果を区別する。

## 8. 今回の限定probeと未測定領域

ソース確認に加え、既存`native/lightcraft/nr_probe.py`等が使うMCP・artifact検証・Region validationを再利用する一時診断コマンドを起動した。計画条件は合成RGB PNG 768×512、grain amount=70 / size=25 / roughness=50 / seed=12345、cache off、CPU/DX12で同条件のWhole反復、Draft/Full、context16のRegion、OFF→ON復帰を比較するもの。trackedのprobeソースやNativeソースは作成・変更していない。

**実測結果は取得できなかった。** リポジトリ`.venv`のPythonで起動したコマンドが出力なしで完了しなかったため停止した。Native起動・artifact照合・GPU実行・画像比較のどこまで進んだかも確認できず、成功/失敗の画質データとして扱わない。本書の再現性・座標・filterに関する結論はソース調査であり、今回のprobeで検証済みという意味ではない。実RAWの再描画一致と性能は未測定。

同じRAWでの冷起動・再open・Recipe復元後の再描画、RAW source level切替、grain size=0と低密度Whole、crop/flip/straighten付き粒子、Effects最大値＋NR最大値、解像度4096以上のcontext16境界差・性能・RSS/VRAMは未実測。ソース上の粒子決定論を、これらの最終画像が全条件で完全一致したという報告へ読み替えない。

## 9. A/B/C/D判定と推奨実装順序

分類は「Native描画・公開設定APIの有無」を基準とする。AでもGenzoRoom allowlist/表示登録と回帰テストは必要であり、現在UIへ接続済みという意味ではない。

| 機能 | 判定 | 根拠 / 条件 |
|---|---|---|
| テクスチャ | A | `develop::controls::CONTROLS`→`local::prepare`→CPU/GPU finish。Region halo検証を残す |
| 明瞭度 | A | 同上、`guided_fast`＋clarity項。Region格子・tone base相互作用に注意 |
| かすみの除去 | A | dark/airlight→CPU/GPU dehaze。全体proxy差と広い参照幅を検証 |
| 周辺光量補正量・中心点・ぼかし・丸み・ハイライト | A | `finish::vignette`→`Vig`→CPU/GPU vignette。Highlightsの実効条件を明記 |
| モード3択 | B | `VignetteStyle`＋`develop.merge`が存在。GenzoRoomにenum操作UIとHistory種別を追加。3モードが常に異なる画を出す保証はない |
| 粒子量・サイズ・粗さ | A | `FinishParams::new`→`grain_noise`＋GPU hash。seedを全snapshotで保持 |
| カテゴリON/OFF | A | `develop.sectionEnabled`＋`FinishParams::new`の`effects` gate。既存UIを再利用 |
| GenzoRoom Effects統合カテゴリReset | A（adapterで複合化） | `DevelopSettings::reset_section`の3sectionを既存commands mutationへまとめる。Native新規機能不要 |
| seed公開操作 | D（今回の範囲外） | API/描画はあるが依頼の公開UIには不要。内部保存は必須 |

対象11数値＋モードにC/Dはない。「ColorとPaintが違う画を出す」「Highlightsが全モード/正補正で働く」を新しい受入条件にする場合のみCになるが、LightCraft既存仕様の統合には要求しない。Region一致が実測で許容外なら、adapterのcontext方針・同一grid比較・airlight差を先に切り分け、Native改修が必要かを判断する。調査段階からpatchを追加する根拠はない。

### 推奨: 共通土台を共有し、受入を段階化

1. **設定・永続契約の土台**: 全11数値、`effects`カテゴリ、style enum、複合Reset、全settings readback検証、Historyの型/metadata/changes/表示を同時に揃える。DB変更なし。既存保存済みEffects値を初期化しない。
2. **周辺光量補正＋粒子**: 3択UI、従属disabled、ON/OFF復帰、Reset時style/seed保持、モード→Undo/Redo→Recipe再openを確認。座標/seedを切り分けやすいので先に受入する。
3. **テクスチャ→明瞭度→かすみの除去**: UIは同じ機構で追加可能。個別の正負/最大値と、既存NR/シャープ併用のcontext16比較を行う。かすみはhalo拡大で改善する成分とairlight差を分離する。
4. **整合性・性能の判断**: 代表RAWで既存診断のWhole同virtual寸法crop対Region validRegion、cold/warm・Draft/Full・CPU/DX12実行結果を比較。crop・image端・異なるwindow originも含める。必要なら固定context拡大、設定依存context、Whole fallbackのどれが最小かを実測で選び、必要となったNative変更は別途設計する。

一括のコード変更自体は可能だが、共有slider登録だけでPhase 6全体の受入を済ませるのは推奨しない。Native更新の前に、既存描画を使う小さな統合と空間filter整合性の受入を分ける方が原因を絞れる。

### 次工程で必要な検証と未決定事項

* focused backend: 11数値のreadback、mode enum拒否、従属無効中の値保持、全ResetとカテゴリReset差、複合Reset中間失敗からのrestore、retry冪等、modeを含むUndo/Redo・redo枝切捨て・Recipe再open。非公開seed/styleと他カテゴリ不変を全settings比較で検査。
* focused frontend: カラー→基本補正→エフェクト→ディテール、日英表示、mode radioのkeyboard/focus、amount=0遷移中のgesture確定、無効中値保持、Reset/モード切替との境界、history label、保存失敗/Preview失敗の既存UX維持。
* RAW実測: 粒子ありの同一条件再描画（cache off/on、process再起動/restore）、Whole/Region、CPU/DX12。粒子自体の差を見るときはgrainなしの差も取得し、前段輝度誤差とhash位置ずれを分ける。境界差はmax/mean LSBと位置別に記録し、見た目だけで判断しない。
* 製品判断: カテゴリResetでstyle保持を採用するか（本書推奨）、同じ描画となるモード条件の説明方法、Region誤差の許容基準。これらを未決定のまま独自Native挙動を足さない。
* 手動確認: Windows実機でFit/100%、明部保護、粒子の密度切替、Region境界、操作focus。ブラウザ/NAS/Firefoxによる動的確認は本調査では行っていない。

本調査では文書だけを変更するため、Frontend/Backend全suite、型チェック、production build、Docker Smoke、Native buildは再実行しない。文書の差分・参照整合と`git diff --check`を確認する。実装完了や実機受入を主張しない。
