# GenzoRoom 開発ノート

現在の最近の写真取得上限は100件。以下の過去フェーズに記した50件は、当時の仕様を示す。

## Color Grading / Midtones Tint（最新フェーズ）

Midtones（中間調）のTemperature（色温度）の下へTint（色かぶり補正）を追加した。範囲−100〜+100、step 1、初期値0、単位なし。負がGreen、正がMagenta。既存AdjustmentSliderとTint gradientを再利用し、drag・直接入力・keyboard・wheel・500ms inactivity commitを共有する。カテゴリOFF中もShadowsとMidtonesの4値を保持する。

recipeはflat構造のv14で`adjustments.midtonesTint: 0`を追加した。Color Grading Resetは4値を0へ戻してenabledを保持し、All Resetは14値と4カテゴリを既定状態へ戻す。個別Reset、カテゴリReset、ON/OFF、History、Undo/Redo、Asset ID別sessionは既存方式を使う。

処理順はGlobal Temperature → Global Tint → Basic tone controls → Shadows Temperature → Shadows Tint → Midtones Temperature → Midtones Tint → Vibrance → Saturation。Midtonesの2項目は、Shadows Tint後の8-bit sRGBから求めた同じ`Y = 0.2126R + 0.7152G + 0.0722B`と`weight = smoothstep(0.15, 0.35, Y) × (1 - smoothstep(0.60, 0.78, Y))`を共有する。0.15以下と0.78以上は0、0.35〜0.60は1。Tintは既存の`u = midtonesTint / 100`、`R = B = 1.3^u`、`G = 1.3^-u`をlinear RGBで`effectiveGain = gain^weight`として適用し、clip・sRGB encode・8-bit丸めを行う。Shadowsのweightとstageは変更していない。

検証：Frontend全テストとTypeScript/Vite production buildが成功した。Midtones Tintの0でのbyte identity、±100の方向、weight境界、alpha、clip、処理順、bypass、Reset、History、Undo/Redo、UI操作、Worker経由の一致を自動テストで確認した。ブラウザ手動確認、fixture・画像・モックデータ作成、Commit / Pushは行っていない。

実機Firefox・実Immichでは、中間調のGreen/Magenta方向、暗部・明部への作用がないこと、fadeの自然さ、TemperatureとTintの同時適用、Color Grading OFF中の4値保持と再適用、各Reset、History、Undo/Redo、Filmstrip切替を確認する。

## Color / Vibrance / Saturation（以前のフェーズ）

右ペインの「色補正 / Color」で、彩度 / Saturationの上へ自然な彩度 / Vibranceを追加した。両方とも−100〜+100、step 1、初期値0、単位なしで、既存AdjustmentSliderの通常trackとdrag・直接入力・キー・wheel・500ms inactivity commitを共用する。カテゴリ順はWhite Balance → Basic → Color、Color内はVibrance → Saturation。既存の開閉、左chevron、独立ON/OFF、Reset、dark hover、focus-visibleは維持した。

現在のrecipeは `{ version: 10, whiteBalanceEnabled: true, basicEnabled: true, colorEnabled: true, adjustments: { temperature: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, whites: 0, shadows: 0, blacks: 0, vibrance: 0, saturation: 0 } }`。adjustmentsはflatのまま、永続化・migration framework・generic category frameworkは追加していない。

処理順は Temperature → Tint → Exposure → Contrast → Highlights → Whites → Shadows → Blacks → Vibrance → Saturation。VibranceはBlacks後の8-bit sRGBに対して、`Y = 0.2126R + 0.7152G + 0.0722B`、`chroma = max(|R-Y|, |G-Y|, |B-Y|)`、`lowSatWeight = 1 - clamp(chroma / 0.5, 0, 1)`を使う。正値では`strength = 0.75 × lowSatWeight`、負値では`strength = 0.6 × (0.25 + 0.75 × lowSatWeight)`、`factor = 1 + vibrance / 100 × strength`、`outC = clamp(Y + (C-Y) × factor, 0, 1)`とする。正方向は低彩度を優先しSaturation +100より穏やか、負方向は−100でもfactorを0にせず完全グレー化を避ける。Vibranceを8-bitへ丸めた後、既存Saturationを適用する。各値0ではstageをskipし、alphaは変更しない。既存tone・Saturation数式、作用域、Issue #2のskip最適化は維持した。

Color OFFはVibranceとSaturationだけを既定値として扱い、両値はrecipeに保持してONで再適用する。White Balance、Basic、Colorは互いに独立し、すべてOFFでもflagだけを理由にpipeline全体を即returnしない。個別Resetは各値だけ、Color Resetは両値を0へ戻してcolorEnabledを維持する。White Balance ResetとBasic Resetは両値を保持する。All Resetは10値と3カテゴリのenabledを一操作で既定値へ戻す。Vibrance変更・個別Resetも日英Historyへ追加し、pending commit、Undo/Redo、最新順、未知kind非fallbackを維持した。

検証：Frontend全292件、TypeScript/Vite production build、git diff --checkを実行した。Vibranceのbyte identity、低彩度優先、高彩度抑制、負方向、0付近の連続性、gray不変、alpha、clip、Vibrance → Saturation順、3カテゴリの独立bypassと値保持、Reset、History、Undo/Redo、pending commit、UIの範囲・順序・disabled・キー・wheel・直接入力を自動テストで確認した。既存Saturationと各回帰テストも成功した。ブラウザ手動確認、手動確認用fixture・画像・モックデータ作成、Commit / Pushは行っていない。

実機Firefox・実Immichの写真では、Color内がVibrance → Saturation順であること、狭幅とリサイズ時の行レイアウト、Vibrance正値が低彩度色へ優先的に作用すること、高彩度色の増加がSaturationより穏やかなこと、負値で完全グレーにならないこと、Color OFF中の両値保持と再適用、他カテゴリとの独立性、各Reset、History、Undo/Redo、drag・直接入力・キー・wheel、Filmstrip切替、ViewerのZoom/Panを確認する。

## White Balance / Temperature / Tint（以前のフェーズ）

右ペインの「色温度補正 / White Balance」に、Temperature直下の色かぶり補正 / Tintを追加した。TemperatureとTintはいずれも−100〜+100、step 1、初期値0、単位なし。Tintは負値がGreen、正値がMagenta、0が無補正。JPEG / Immich previewへの相対シフトであり、Kelvin指定やRAWの絶対WBではない。

このフェーズのrecipeは `{ version: 8, whiteBalanceEnabled: true, basicEnabled: true, adjustments: { temperature: 0, tint: 0, exposure: 0, contrast: 0, highlights: 0, whites: 0, shadows: 0, blacks: 0 } }`。adjustmentsはflatのまま、永続化・migration framework・generic category frameworkは追加していない。

White Balance専用キーはTemperatureとTintで、effectiveAdjustmentsはWhite BalanceがOFFなら両方だけを既定値へ置き換える。両値はBasic 6項目の一覧に含めない。両カテゴリOFFでもカテゴリflagによるpipeline全体の即returnは行わず、有効値の無補正判定で返す。OFF中の値は保持し、ONで再適用する。

処理順は Temperature → Tint → Exposure → Contrast → Highlights → Whites → Shadows → Blacks。Temperature式は従来どおり `R = 1.5^(-t/100), G = 1, B = 1.5^(t/100)`。Tintは正規化したuに対して `R = 1.3^(u/100), G = 1.3^(-u/100), B = 1.3^(u/100)` とした。u=+100はR/G/B = 1.3 / 0.769230… / 1.3、u=−100は0.769230… / 1.3 / 0.769230…で、各channelは符号反転時に逆数になる。各stageでsRGBをlinear RGBへ変換してgainを乗算し、0〜1へclip、sRGBへ戻して8-bitへ丸める。値0ではそのstageの往復を省略する。alphaは変更しない。既存toneの数式・作用域・中間8-bit丸め・Issue #2のskip最適化、Temperature式、Shadows/Blacksのアルゴリズムは変更していない。

Temperature/Tint個別Resetは各値だけを0にする。White Balance Resetは両値を0にしてON/OFFを保持し、Basic Resetは両値を保持する。All Resetは8項目の既定値と両カテゴリONを復元する。カテゴリ操作前にpendingをcommitし、カテゴリReset / All Reset自体は各1 History operation。Tint変更・個別Resetも日英Historyへ追加し、Undo/Redo、最新順、未知kindを既知補正にfallbackしない方針を維持した。

共通AdjustmentSliderの既存optional trackGradientを再利用した。Temperatureは赤橙 #d86943 → 無彩色 #b6b6b6 → 青 #4e8ed9、Tintは緑 #4f9b62 → 無彩色 #b6b6b6 → マゼンタ #b05aa0。Basicのnative range外観と全操作handlerは従来どおり。drag、直接入力、左右1 step・上下10 step、wheel 10 step・Shift+wheel 1 step、500ms inactivity commit、disabledとpending coalescingを共用する。

検証：Frontend全267件が成功。Tintのbyte identity、Green/Magenta方向とgain対称性、clip・極端値・alpha・Temperature → Tint → Exposure順、独立bypass/Reset、Undo/Redo/pending、日英Historyを確認した。既存Temperature、Basic 6項目、Issue #2固定ハッシュのpixel compatibility、Viewer / Filmstrip / Sidebar / multi-selectも回帰テストを通過。TypeScript/Vite production buildとgit diff --checkも成功。手動ブラウザ確認および確認専用fixtureの作成は行っていない。

実機Firefox・実Immichの写真では、肌、白壁、植物、蛍光灯下、暗部、飽和色でTint ±25/±50/±100の強度とclipを確認する。Green/Magentaの符号、中央neutral、Tint gradientとthumb視認性、230 / 313 / 440pxの日英Sidebar、drag/直接入力/キー/wheel、OFF/Reset/Undo/Redo、Filmstrip切替中のpending、ViewerのZoom/Panも確認する。デプロイ手順は変更していない。

この時点ではColorカテゴリとSaturationは未実装だった。後続フェーズでもBasicの6項目とWhite BalanceのTemperature/Tintの対象範囲は維持する方針とした。

## JPEG Exposure / Contrast / Highlights / Whites / Shadows / Blacks編集基盤（以前のフェーズ）

JPEGのみを対象に、露光量 −5〜+5 EV（0.01 EV刻み、初期値0）、コントラスト・ハイライト・ホワイト・シャドウ・ブラック −100〜+100（1刻み、初期値0）の調整を追加した。RAW/DNG・HEIC処理、Backend、DB、永続保存、Immich書き戻しには変更を加えていない。

編集はAsset IDごとのメモリ上のsessionで保持する。recipeを `{ version: 6, basicEnabled: true, adjustments: { exposure: 0, contrast: 0, highlights: 0, whites: 0, shadows: 0, blacks: 0 } }` とし、Historyは操作種別・変更前後recipe・cursorを持つ。Filmstrip切替では各Assetの状態を保持し、暗室を離れるかリロードすると消える。各個別Reset、基本補正ON/OFF、基本補正Reset、All Resetは別の操作種別で、いずれもUndo可能。基本補正Resetは有効状態を維持して6項目だけを1操作で0へ戻す。All Resetは6項目を0へ戻し、`basicEnabled`も既定値trueへ戻す。Historyでは基本補正ON/OFF、基本補正Reset、All Resetを簡潔な1件として表示する。将来永続化する際はversion 5以前のrecipeへ `basicEnabled: true` を補い、それ以前のversionについては各必須adjustmentも段階的に補うmigrationが必要になる。

操作開始時のrecipeをpendingに保持し、操作中はcurrent recipeだけを更新する。ドラッグ終了/cancel、コントロールのunmount、キーボードまたはwheel入力停止500msでcommitする。キーボードとwheelでは受理した入力ごとにtimerをresetし、keyup、pointer leave、focus移動では早期commitしない。細かな入力はHistoryに積まず、同値へ戻る操作も履歴を作らない。Undo後に新しい変更をcommitした場合だけRedo側を破棄する。

共通AdjustmentSliderはホバーまたはフォーカス中に左右1 step・上下10 stepで操作できる。range上のwheelはdeltaYの符号だけを使い、上方向を加算、下方向を減算として扱う。通常wheelは上下キー相当の10 step、Shift+wheelは左右キー相当の1 stepとする。実際に値が変わったwheelだけを`preventDefault`し、境界、deltaY=0、disabled、number入力やslider外のwheelは通常のscrollへ渡す。別のrangeにフォーカスしている場合はそのrangeを優先する。テキスト入力、textarea、select、contenteditable、IME変換中は独自ショートカットで操作を奪わない。Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z、Ctrl/Cmd+Yと画面ボタンを用意した。

現像項目を増やす前提で、AdjustmentSliderをラベル・range・直接数値入力・任意の単位・小型個別Resetが横並びになる1行グリッドへ整理した。6項目は「基本補正」カテゴリ内へ配置し、カテゴリ見出しから折り畳み、ON/OFF、6項目一括Resetを操作できる。折り畳み状態はUIローカルで毎回展開から始まり、recipeへは保存しない。OFF中は値を保持したままpipelineをバイパスし、内部controlをdisabled・dim表示にする。暫定preview注釈はカテゴリ外にあるため、折り畳みやOFFに関係なく表示する。重複していたスライダーのキー操作説明はパネルから削除した。

ラベル列は長い場合に省略し、range列が右サイドバーの残り幅へ追従する。単位は空でも固定幅を予約してslider端を揃え、数値欄は44pxとした。Exposureは −5〜+5 EV、0.01 EV刻み、表示2桁、Contrast・Highlights・Whites・Shadows・Blacksは −100〜+100、1刻み、整数表示。直接入力中は有限値をstepと範囲へ正規化してcurrent recipeへ反映し、Enterまたはblurでcommit、Escまたは空・無効入力で編集開始値へ戻す。編集中だけdraft文字列を表示し、確定後はslider、ホバーキー、Reset、Undo/Redoなど全経路のrecipe値へ即時追従する。number入力中のカーソルキーは既存のホバースライダー操作から除外する。個別Resetは既定値0のときdisabledにし、All Resetは個別Resetと区別できるようDevelop Controls見出し右端へ配置する。

画像取得はeditImageSourceに隔離し、今回はImmich previewを暫定入力にした。`basicEnabled`がfalseなら未変更sourceを返し、6項目の値は書き換えない。有効時はブラウザでsRGB RGBAへdecodeし、まずsRGBの伝達関数を戻した線形光へ2^EVを乗算してsRGBへ戻す。その後、各sRGB channelを0.5中心に `1 + contrast / 100` 倍して0〜1へclipする。HighlightsはsRGB輝度 `Y = 0.2126R + 0.7152G + 0.0722B` から0.5〜1.0のsmoothstep重みを求め、正値では `1 - (1 - Y)^2`、負値では `Y^2` へ補間する。WhitesはHighlights後の輝度0.75〜1.0をsmoothstepで選び、正値では1.0、負値では0.75へ補間する。ShadowsはWhites後の輝度から0〜0.15のsmoothstep重みを求め、正値では `sqrt(Y)`、負値では `Y^2` へ補間する。BlacksはShadows後にMaster Black / Pedestalとして、`weight = 1 - smoothstep(0, 0.35, Y)`、`newY = clamp(Y + blacks / 100 × 0.10 × weight, 0, 1)`を適用する。作用は黒で最大、0.10〜0.20でも明確に残り、0.30付近で弱まり、0.35で連続的に0になる。非ゼロ輝度には目標輝度と元輝度の比をRGB共通倍率として適用し、倍率では持ち上げられない完全な黒だけは色相が定義されないため無彩色として扱う。Shadowsは暗部階調を曲線で起こす／沈める操作、Blacksは低域全体の基準レベルを加算offsetで上下する操作として分けた。alphaを維持し、毎回未変更の画素bufferからExposure → Contrast → Highlights → Whites → Shadows → Blacksの順に計算するため累積劣化しない。requestAnimationFrameで更新をまとめ、Canvasだけを書き換えるのでViewerのZoom/Panは編集値変更で初期化されない。

8-bit・ブラウザの色管理・既存previewに依存する暫定表示であり、originalと同等の品質やRAWのハイライト復元は保証しない。現在の1:1もpreviewのpixel基準。将来JPEG originalへ切り替える際は取得adapterを差し替え、元画像とpreviewの向き・色空間・寸法を検証する。このフェーズ当時は大画像のmain thread負荷を課題としていた。現在の画素処理はWorker経路を持つ。

DB導入時はrecipe versionの検証/migration、Assetと入力画像・処理versionの紐付け、commit時の原子的保存を設計する。previewベースのレシピをoriginalへ無条件に適用して同じ見え方になるとは扱わない。pending操作やCanvas bufferは永続化対象にせず、Historyを保存するかは別に決める。

### 最新フェーズ実装時の検証記録

検証：Frontend 160件のテストおよびproduction buildが成功。純粋画素テストではBlacks 0 / +100 / −100、0.10〜0.20の明確な作用、0.30付近の弱い作用、0.35以上の不変、完全黒のlift、色付き暗部のRGB構成比、他5補正との処理順に加え、基本補正OFF時の完全bypassと値保持を確認した。UIテストではカテゴリの初期展開・折り畳み・再展開、OFF中のcontrol無効化、ON/OFFとカテゴリResetとAll ResetのUndo/Redo・簡潔なHistory、カテゴリ外の暫定注釈を確認した。ローカルの640×360グラデーションfixtureを使うChromium確認では、基本補正のOFF・値保持・control無効化、折り畳み・再展開、カテゴリReset、Undo/Redo、All Reset、History、操作説明の削除、カテゴリ外の暫定注釈を確認した。右パネル230 / 350 / 440pxではカテゴリに横overflowがなく、range幅は約41 / 138 / 228pxへ追従し、ページにも横overflowは発生しなかった。再読み込み後はカテゴリが展開状態から始まり、右パネル幅は保持された。Chromiumではrange上の通常wheelでExposureが1 eventにつき0.10 EV変化し、500ms後に1件だけHistoryへcommitされること、range外では右パネルが通常scrollし、Basic OFF中のrange wheelは値を変えず通常scrollへ渡ることを確認した。既存自動テストで直接入力、hover/focusキー操作、keyboard/wheelの500ms commit、個別Reset、Viewer、Sidebar resize、Filmstrip、multi-select等の回帰を確認している。実Immich/NAS接続、実写真の色再現、大画像の性能、Firefoxは今回未検証。Backendは未変更で、Backendテストは今回再実行していない。

### Issue #2: preview処理の局所最適化

各段階の輝度を計算した後、Highlightsは `Y <= 0.5`、Whitesは `Y <= 0.75`、Shadowsは `Y >= 0.15`、Blacksは `Y >= 0.35` の画素について、その段階の重み・target・倍率計算、丸め、RGB書き戻しを省略した。後続の補正は引き続き実行する。既存の1画素ループ、Exposure / ContrastのLUT、補正順、各段階の8-bit丸めを維持し、AdjustedImage、recipe、History、UI、Backendは変更していない。

変更前 `99c58aae3ec621eddbea0b4d7e5ba76c52be5147` と全16,777,216 RGBを比較し、4補正それぞれの±100と3通りの複数補正（指定6補正、その符号反転、clippingを含む組み合わせ）でbyte単位の一致を確認した。通常の回帰テストには、変更前から採取した固定SHA-256、決定的な色付き画素・全256グレー・可変alpha、対象域内外の確認を追加した。

Node.js 24.19.0上の参考計測。seed 17の疑似乱数RGB・alpha 255、3回ウォームアップ後7回の中央値。変更前後を交互の順番で計測した。6補正値は順に `+0.5 / +20 / -30 / +25 / +40 / -20`、Exposure単独は `+0.5`。単位はms。

| サイズ | 無補正（前→後） | Exposureのみ（前→後） | 6補正（前→後） | 6補正の時間削減率 |
| --- | --- | --- | --- | --- |
| 640×360 | 0.16 → 0.17 | 1.69 → 1.72 | 30.08 → 17.85 | 40.7% |
| 1920×1080 | 1.13 → 1.18 | 17.28 → 17.90 | 269.47 → 159.81 | 40.7% |
| 2560×1440 | 2.39 → 2.36 | 30.84 → 33.01 | 480.21 → 285.57 | 40.5% |

再計測は `frontend/` から `node scripts/benchmark-preview.mjs 99c58aae3ec621eddbea0b4d7e5ba76c52be5147` を実行する（Node 24と対象commitを含むGit履歴が必要）。無補正・Exposure単独には改善傾向はなく、小幅な増減がある。これは画素処理と出力buffer確保だけの計測であり、decode、Canvas転送、React、requestAnimationFrame、実写真・実機Firefoxの操作時間は含まない。当時は大きなpreviewの処理時間を課題としており、この計測フェーズではWorkerやGPU処理を導入していなかった。現在はWorker経路を使用する。

### Issue #3: Basic編集controlsの内部整理

Basic 6項目のkey・翻訳キー・範囲・step・表示桁・単位・formatter・Reset識別をbasicControls.tsへまとめ、BasicAdjustmentControlsを画面とDOM操作テストで共有した。Historyも同じ定義から値を表示し、未知のkindは識別文字列だけを表示してExposureの値へfallbackしない。最新順、Basic ON/OFF・Basic Reset・All Resetの簡潔な表示とHistory構造は維持した。

editing.tsの明示的なBasicキー一覧をReset・既定値判定・bypassへ使用する。Resetとbypassは6項目のみを既定値へ戻し、追加のadjustmentを保持する。pipelineは有効なadjustmentsを受け取る部分のみ変更し、画素計算・処理順・作用域・Issue #2のskip最適化・benchmarkは維持した。recipe version 6、平坦なadjustments、Undo/Redo、pending、AdjustmentSliderの入力仕様は変更していない。

検証：Frontend全209件（既存187件＋追加22件）とTypeScript/Vite production buildが成功。既存の固定ハッシュによる画素互換性、Viewer / Filmstrip / Sidebar / multi-selectの回帰も通過。git diff --checkに問題なし。実機Firefox・実Immich接続は未確認。

将来White Balance / Colorを追加する際は、各カテゴリのUI・History表示・既定値・actionとrecipe全体の同値判定を拡張し、pipelineの処理順と無補正時の早期returnを見直す。Basicのキー一覧へ別カテゴリの項目を追加しない。実機Firefoxではdrag・数値入力・矢印キー・wheel/Shift+wheel・500ms単位のHistory、OFF/Reset/Undo/Redo、Filmstrip切替中のpending、Sidebar resizeとViewerを確認する。

## 過去フェーズの記録

以下は各フェーズで行った実装、実機確認、設計判断、トラブルシュートの記録であり、当時の「未実装」の記述を含む。現在の実装状況は冒頭の最新フェーズと[README](../README.md)を参照する。公開リポジトリに置くため、APIキーなどの秘密情報は記録しない。

## 1. プロジェクト概要

GenzoRoomは、Immich上の写真をWebブラウザから現像・色補正するためのセルフホスト型アプリを目指している。趣味と学習を兼ねたプロジェクトで、GitHubのPublicリポジトリで開発している。

README、CHANGELOG、architectureなどの外向けドキュメントは英語で記述する。この開発ノートとデプロイノートは、将来自分が経緯や運用方法を思い出すため、日本語で記述する。

Codexは実装、確認、差分整理までを担当する。commitとpushはCodexでは行わず、自分がVS Codeで差分を確認してから実行する。

## 2. 初期技術構成

第三段階までの構成は次のとおり。

- Frontend: React + TypeScript + Vite
- Frontend配信: nginx
- Backend: FastAPI / Python
- Backend実行: Uvicorn
- デプロイ: Docker Compose
- Web UIのデフォルトホストポート: `3190`
- Backendのコンテナ内部ポート: `8000`

NASではViteの開発サーバーを常時動かさず、ビルド済みの静的ファイルをnginxから配信する。ブラウザのAPIアクセスは同一オリジンの `/api/...` を使い、nginxがBackendへ転送する。Backendの8000番はホストへpublishしない。

NASホストOSへアプリ固有設定を直接書き込まない方針とした。`privileged`、`host network`、不要なbind mountは使わない。現時点では永続データがないため、アプリ用Volumeも作成していない。

## 3. 第一段階: FrontendとBackendの疎通

目的は、次の最小経路をNAS上で確認することだった。

```text
Browser → Frontend / nginx → Backend GET /health
```

nginxはブラウザからの `GET /api/health` を、Docker内部のBackendにある `GET /health` へproxyする。実機では次を確認できた。

- NAS上でFrontendの画面を表示できた。
- 画面に `Backend: Connected` と表示された。
- nginxからBackendへの `/api/health` のproxyが動作した。
- Frontendの3190番だけがホストへ公開された。
- Backendの8000番はDocker内部だけで利用された。

この段階ではImmich接続や写真取得を実装していない。

## 4. 第二段階: Immichへの認証付き接続

目的は、GenzoRoom BackendからImmich APIへ到達でき、APIキーが受理されることを確認することだった。単なるTCP接続確認ではなく、読み取り専用の認証済みAPIを使用した。

- Immich API: `GET /api/users/me`
- 認証ヘッダー: `x-api-key`
- 必要権限: `user.read`

Frontendでは次の状態を表示する。

- `Immich: Connected`
- `Immich: Not configured`
- `Immich: Connection failed`

接続情報はBackendの環境変数 `IMMICH_URL` と `IMMICH_API_KEY` から受け取る。現在はPortainer StackのEnvironment variablesで管理し、実値をソースコード、Docker image、GitHubリポジトリへ保存しない。

BackendからImmichへのHTTPリクエストにはtimeoutを設定した。TLS証明書検証は無効化せず、過剰なretryも行っていない。エラーレスポンスやログにはAPIキー、上流レスポンス本文、内部例外の詳細を出さない設計にした。

## 5. Backend DockerfileのCOPY漏れ

第二段階をNASへデプロイした際、Backendが次のエラーで起動できなかった。

```text
ModuleNotFoundError: No module named 'immich'
```

原因は、Dockerfileが `main.py` だけをDocker imageへCOPYしており、新しく追加した `backend/immich.py` がコンテナ内の `/app` に存在しなかったことだった。Uvicornは `/app` を作業ディレクトリとして `main:app` を起動し、`main.py` から `immich` をimportするため、同じimport path上に `immich.py` が必要だった。

Dockerfileを次の方式へ変更した。

```dockerfile
WORKDIR /app
COPY . .
```

同時に `backend/.dockerignore` で、次のような本番imageに不要なものを除外した。

- `tests/`
- `__pycache__/` とPythonキャッシュ
- 仮想環境
- `.env` と `.env.*`
- テストカバレッジやテストキャッシュ
- Dockerfileと `.dockerignore` 自体

これにより、今後Backend配下へPythonモジュールを追加しても、個別の `COPY` 追加を忘れて起動に失敗しにくくなった。一方で、開発専用ファイルや秘密情報はimageへ含めない。

## 6. QNAP上のhairpin / NAT問題

GenzoRoom BackendコンテナからImmichへ接続できなかった際、接続先を変えて切り分けた。結果は次のとおり。

| Backendコンテナからの接続先 | 結果 |
| --- | --- |
| `192.168.10.100:3190` | Timeout |
| `192.168.10.100:2283` | Timeout |
| `192.168.10.1:80` | OK |

`192.168.10.100` はQNAP自身のLAN IPである。別のLAN機器である `192.168.10.1` へは接続できたため、コンテナからLAN側への通信全体が遮断されているわけではなかった。また、QNAP自身の3190番とImmichの2283番がどちらもTimeoutしたため、Immich APIやAPIキーだけの問題とも考えにくかった。

この結果から、現在のQNAP環境では、コンテナからQNAP自身のLAN IPへ戻るhairpin / NAT相当の通信だけが通らないと判断した。NASホストOSのネットワーク設定を変更して回避する方式は採らず、同一Dockerホスト上のImmichには共有Docker networkを経由して接続することにした。

## 7. 同一Dockerホスト上のImmich接続

現在のQNAP環境で確認した値は次のとおり。

- ImmichのDocker network: `immich_immich-net`
- Immich Serverコンテナ: `immich_server`

Portainerでは次の環境変数を設定し、接続に成功した。

```env
IMMICH_DOCKER_NETWORK=immich_immich-net
IMMICH_URL=http://immich_server:2283
```

`immich_immich-net` と `immich_server` は現在のQNAP環境に固有の値である。GenzoRoomのアプリケーションやComposeファイルにはハードコードしていない。他の環境では、実際のImmich network名とサービス名またはコンテナ名を確認して設定する必要がある。

公開リポジトリでは接続方式を次の2つに分けた。

- 通常接続: `docker-compose.yml`
- 同一Dockerホスト接続: `docker-compose.yml` と `docker-compose.immich-network.yml`

追加Composeは、既存の外部Immich Docker networkへBackendだけを参加させる。FrontendはImmich networkへ参加せず、Immich APIキーも受け取らない。通常のLAN経由やHTTPS経由で接続できる環境では、追加Composeを使う必要はない。

## 8. Portainer Repository Stack

GitHub RepositoryをPortainerのSourceとして登録し、Repository StackとしてGenzoRoomをデプロイしている。現在の設定は次のとおり。

- Repository reference: `refs/heads/main`
- Compose path: `docker-compose.yml`
- Additional paths: `docker-compose.immich-network.yml`

GitHubへpushした後、Portainerの **Pull and redeploy** で新しい内容を取得して再デプロイする。環境変数はGitHub側へ置かず、Portainer側で管理する。

Portainerを使うことで、GitHubからの取得、複数Composeの組み合わせ、環境変数、Container Logs、Container ConsoleをGUIから確認できている。トラブル時にはまずLogsを確認し、必要に応じてConsoleから名前解決やHTTP接続を切り分ける。

## 9. 第三段階: 最近の写真とサムネイル

目的は、Immichから最近の写真を最大50件取得し、Frontendへサムネイル一覧として表示することだった。

一覧取得には次のImmich APIを使用する。

```text
POST /api/search/metadata
```

検索条件は次のとおり。

- `IMAGE` のみ
- `fileCreatedAt` の降順
- 最大50件

サムネイル取得には次のAPIを使用する。

```text
GET /api/assets/{id}/thumbnail?size=thumbnail
```

第三段階時点でAPIキーに必要な権限は次の3つ。

- `user.read`: 接続確認
- `asset.read`: 写真メタデータの検索
- `asset.view`: サムネイルの取得

書き込み、アップロード、削除などの権限は付与していない。

GenzoRoom Backendには次のAPIを追加した。

- `GET /assets/recent`
- `GET /assets/{id}/thumbnail`

FrontendはImmichを直接呼ばない。一覧APIはAsset ID、ファイル名、日時、GenzoRoom側のサムネイルURLだけを返す。サムネイルもBackendが代理取得するため、APIキーはBackend内だけで使われ、ブラウザへ渡らない。

実機では、現在のQNAP / Portainer環境で最新写真の一覧とサムネイル表示に成功した。

## 10. RAWとJPEG / HEICの扱い

実機確認では、Immich自体がRAWとJPEG / HEICを別々のAssetとして表示していることを確認した。GenzoRoomの最近の写真一覧もImmichのAssetモデルをそのまま扱うため、RAWと通常画像は別項目として表示される。

RAW側のサムネイルは通常画像より暗く見えることがある。現時点では、GenzoRoomでRAW現像や明るさ補正を行っているわけではなく、Immichが提供する各Assetのサムネイルを表示しているだけである。

RAWとJPEG / HEICの自動ペアリングや統合表示は未実装。将来必要になれば、同一撮影時刻、ファイル名、連番、メタデータなどを使ったペアリングを検討できる。ただし、誤判定やImmich側のAsset関係との整合も考える必要があるため、現段階では別Assetとして扱う。

## 11. 現時点で未実装

以下は今後の候補であり、第三段階時点では未実装。

- 写真編集画面
- RAW現像
- DNGデコード
- Exposure / Contrast / White Balanceなどの調整
- 非破壊編集パラメータを保存するDB
- Histogram
- Waveform
- RGB Parade
- GPU処理
- 編集結果のImmichへの書き戻し
- JPEG / RAWペアリング

次の段階へ進む際も、一度に広げすぎず、NAS実機で確認できる小さな単位で実装する。

## 12. i18nを早い段階で導入した理由

画面がまだ小さい段階で、Frontendにi18nextとreact-i18nextを導入した。今後UI文言が増えてから文字列を移し替えるより、先に翻訳キーと翻訳リソースの置き場所を決めた方が変更範囲を抑えやすいためである。

英語と日本語の翻訳だけでなく、写真日時も選択中のlocaleへ連動させた。手動選択を保存し、保存値、ブラウザ言語、英語の順で表示言語を決定する。翻訳が不足した場合は英語へfallbackする。

現時点では英語と日本語だけを対象とするが、コンポーネントから表示文言を分離したことで、将来ほかの言語を追加するときも翻訳リソースを中心に拡張できる。

## 13. 画像形式バッジとRAW判定

写真カードで元ファイルの形式を確認できるよう、最近の写真APIに `format` と `is_raw` を追加した。`format` はImmichから取得した元ファイル名の拡張子を正規化した表示値で、`is_raw` は既知のRAW形式かどうかを示す真偽値である。

Frontendは現時点ではこれらを形式バッジの表示にだけ使用する。RAW / 非RAWフィルターはまだ実装していないが、将来フィルターを追加するときにFrontendで拡張子一覧を重複管理しなくて済むよう、RAW判定をBackendのレスポンスに含めた。

## 14. RAW / 非RAWフィルター

このフェーズ当時、最近の写真APIが返した最大50件のAssetに対し、Frontendが `is_raw` を使って表示だけを絞り込んだ。フィルター変更時にBackendやImmichへ再取得しない動作は現在も同じ。

RAWとRAW以外の2つのチェックボックスは初期状態で両方ONとし、片方だけがONになった場合は最後のチェックを外せないようにした。フィルター結果が0件の場合は、Immichからの取得結果自体が0件の場合とは別のメッセージを表示する。フィルター状態は保存せず、再読み込み時には両方ONへ戻る。

## 15. 暗室 / Anshitsuワークスペース

最近の写真をクリックすると、写真ごとのURLを持つ暗室へ遷移する。暗室は将来の現像作業を行う画面で、左にHistory / EXIF、中央に写真Viewer、右上にScope、右下にDevelop controls、下にFilmstripを配置した。左側は参照情報、右側は将来のスコープ表示と現像操作の領域として役割を分けた。左右は独立して閉じられ、編集中は必要に応じてViewerを広げられる。英語UIでは名称を `Anshitsu` とし、意味を補うため `Photo development workspace` を併記する。

この段階では1枚だけを暗室へ渡すが、Frontendの遷移状態は `selectedAssets` と `activeAssetId` を分けた。将来、複数写真を持ち込んでFilmstripから表示対象を切り替える際に、同じ役割を拡張できるようにするためである。ページを直接再読み込みした場合は、URLのAsset IDから詳細を再取得する。

詳細表示画像には原画像ではなく、Immichの `GET /api/assets/{id}/thumbnail?size=preview` で生成済みpreviewを使う。GenzoRoom Backendのproxyを経由するため、Immich APIキーはブラウザへ渡らない。EXIFは `GET /api/assets/{id}` から取得し、GPSを除く主要項目だけをFrontendへ返す。欠損項目は画面に出さない。

左右パネルは独立して折りたためる。中央Viewerは初期状態をFitとし、等倍（1:1）、段階的な拡大・縮小、ホイールズーム、拡大時のドラッグPanに対応した。現像操作、Scope表示、History保存はまだプレースホルダーである。写真の色判断を妨げないよう、暗室だけは無彩色のダークグレーから黒を基調とした。

### モバイル対応方針

Anshitsuはdesktop-firstとし、スマートフォン向けの本格的な現像UIは現時点の対象外とする。Viewerを十分な大きさで表示する必要があり、Scope、Develop Controls、Filmstripを同時に扱う画面は小さい画面では実用性が低いため、詳細な写真現像はPCブラウザを主対象とする。

今後もデスクトップUIの使いやすさを優先し、モバイル対応のためにデスクトップ側を妥協しない。別途明示的な方針変更がない限り、Anshitsu全体をスマートフォン向けのDrawer、Tab、縦積みレイアウトなどへ作り直さず、既存の狭幅表示を致命的に壊さない範囲の対応に留める。モバイル専用の本格現像UIも実装しない。

将来モバイル向けに、写真選択、Asset管理、RAW/JPEGのStack操作、プリセット適用、現像結果のImmich送信などの簡易操作を検討する可能性はある。ただし、これらはAnshitsuの本格現像UIとは分けて設計する。

## 16. 一覧の複数選択とFilmstrip切替

最近の写真一覧では、選択したAsset IDを配列で保持する。Setではなく配列にしたのは、最初に選んだ写真を暗室のactiveAssetにし、選択順をそのままFilmstripへ反映するためである。RAW / RAW以外フィルターは表示対象だけを変え、一覧から一時的に隠れたAssetの選択状態は解除しない。

通常状態でカード本体を押すと、従来どおりその1枚だけを暗室へ渡す。チェックから最初の1枚を選ぶと選択モードになり、以後はカード本体でも選択と解除を切り替える。Desktopでは通常時のチェックをホバーまたはキーボードフォーカス時に表示し、hoverのないモバイルではチェックを常時表示して単写真遷移と複数選択開始を分ける。

「暗室へ」では、選択順に解決した `selectedAssets` と先頭Assetの `activeAssetId` をReact Routerのnavigation stateで渡す。Filmstripで別の写真を押したときは `activeAssetId` とURLだけを切り替え、`selectedAssets` は維持する。再読み込み時にnavigation stateが失われた場合は、URLのactiveAsset 1枚をImmichから再取得する既存挙動へ戻る。
