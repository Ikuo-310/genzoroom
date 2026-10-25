# RAW Region Preview：工程C 実装前設計

2026-10-24（Asia/Tokyo）。初回調査基準GenzoRoom `79e198ede4750f52fbed9116d6351597f62755c3`、`feature/lightcraft-integration`。B1は[Windows受入記録](RAW_ADAPTIVE_PREVIEW_DESIGN.md#b1-windows-acceptance)により完了。§1〜10は初回設計、**C0契約固定の完了記録・厳密な規則は§11を正本**とする。**この冒頭の状態説明は初回調査時点の記録**であり、C1 Native/Backendは§12、C2実装と最終Windows受入は§13〜§17を正本とする。閾値や性能目標の候補を受入済み仕様と読まないこと。

## 1. 調査根拠と確認済み事実

[解像度調査](RAW_RENDER_RESOLUTION_RESEARCH.md)を出発点に、ローカル `.tmp/lightcraft-b1` のHEADがLightCraft v0.10.0 `a2a41383c4fd62fa85a46ccd00998639221f2d3c`であることを確認した。ここにはB1管理patchがあるため、変更のあるEngine／pipeline／GPUファイルは`git show a2a41383:<path>`でも再確認した。以下のリンクと行番号は固定upstream用で、GenzoRoom拡張と区別する。GUI制御の移植は提案しない。

| 固定ソース | 確認した事実 |
|---|---|
| [ui-egui/region.rs](https://github.com/storytold/lightcraft/blob/a2a41383c4fd62fa85a46ccd00998639221f2d3c/crates/ui-egui/src/region.rs) `plan` (227–260)、`SizeHold` (263–300) | 仮想frame長辺がundrafted Whole長辺の1.25倍超でwindow候補。明示preview_limit付きFitでは抑制。操作中のWhole縮小とwindow要否は別。zoom中と終了後0.25秒はサイズ保持。1.25は本家の選択でありGenzoRoom決定値ではない |
| 同 `margin_for` (46–61)、`window_for` (336–363) | 仮想frame長辺の4.5%（3072基準cap）を256px単位に切上げ、可視領域を外向きsnap・clamp。native最大span6144、texture上限でさらに制限。span超過は中央部分のみとなり、全可視域を覆う保証はない |
| [panels/detail.rs](https://github.com/storytold/lightcraft/blob/a2a41383c4fd62fa85a46ccd00998639221f2d3c/crates/ui-egui/src/panels/detail.rs) `request_window` (356–415)、表示 (705–780) | target画像rectから可視rectを仮想frameへ変換。元source未取得中の重複decodeをdefer。Wholeを先に描きwindowをpane/wipeでclipして重ねる。zoom保持中は旧windowを拡大して使用 |
| [engine/media.rs](https://github.com/storytold/lightcraft/blob/a2a41383c4fd62fa85a46ccd00998639221f2d3c/crates/engine/src/media.rs) `SourceLevel` (93–129)、`region_job_of` (1454–1499) | windowの幅ではなく仮想full寸法とcrop需要でsourceを選ぶ。Thumb512／Preview2560／Full原寸。render_jobへwindowとkeyを追加し、遠距離spots/Auto Mask readが収まらなければ拒否。RegionはRAW ROI decodeではなくFull source全体decodeを要し得る |
| [pipeline/geometry.rs](https://github.com/storytold/lightcraft/blob/a2a41383c4fd62fa85a46ccd00998639221f2d3c/crates/pipeline/src/geometry.rs) `Frame::window` (121–139)、[pipeline/lib.rs](https://github.com/storytold/lightcraft/blob/a2a41383c4fd62fa85a46ccd00998639221f2d3c/crates/pipeline/src/lib.rs) `PixelWindow`、`plan` | windowはorientation／crop／straighten／flip適用後の出力pixel座標。Frameがflipを逆変換してcropを縮小し、view offset/full寸法を保存。効果のscaleはfull基準。spotsでwork windowを拡張して出力を要求windowへ切戻す。Dehaze airlightはWhole proxyから計算 |
| [gpu/render.rs](https://github.com/storytold/lightcraft/blob/a2a41383c4fd62fa85a46ccd00998639221f2d3c/crates/gpu/src/render.rs)、[gpu/lib.rs](https://github.com/storytold/lightcraft/blob/a2a41383c4fd62fa85a46ccd00998639221f2d3c/crates/gpu/src/lib.rs) | GPUも共通Planのwindow／fixed_air／keepを使用。大sourceはdevice共有copyを利用する経路があり、view stagesとは別所有。非対応・失敗はCPUへfallback。GPU Regionだからsource全体のメモリが不要とはいえない |
| [ui-egui/render.rs](https://github.com/storytold/lightcraft/blob/a2a41383c4fd62fa85a46ccd00998639221f2d3c/crates/ui-egui/src/render.rs) request (416–483)、採用 (775–879)、[preview/pool.rs](https://github.com/storytold/lightcraft/blob/a2a41383c4fd62fa85a46ccd00998639221f2d3c/crates/preview/src/pool.rs) submit | slotごと未開始job置換、実行中は強制preemptしない。source cache、slot StageCache、表示textureは別。window位置を変えるとPlan geometry keyも変わり、空間stage再利用は保証されない |
| region.rs `RegionView::is_current`、detail.rs `draw_window` | photo／full／settingsを検査し、drag中は旧settings windowも許す。GenzoRoomのACK制限より緩いため、そのまま採用しない |
| [cmd/before.rs](https://github.com/storytold/lightcraft/blob/a2a41383c4fd62fa85a46ccd00998639221f2d3c/crates/engine/src/cmd/before.rs) (17–20) | import/custom基準へ現在crop・orientationだけをコピーする。lens／perspective／自動upright等がAfterと同じとは限らない |

GenzoRoom側は`ImageViewer.tsx`、`rawWholePreview.ts`、`useRawDocument.ts`、`rawApi.ts`、Backend `lightcraft_raw.py`、`lightcraft_runtime.py`、`windows_raw_api.py`、管理patchのframe metadata／StagePoolを確認した。現行RawViewにはPan／可視rectがなく、HTTP／native応答はWhole専用、frame.windowはnull、Viewerは単一imgのBefore/After交換である。工程Cは定数だけの拡張では成立しない。現行frame geometryIdはeffective Planのwarp等も含み、単なる縦横一致ではない。

## 2. B1から維持する不変条件

- Native frameは最終出力の論理座標。センサー配列やPNG naturalWidthではない。PNGは独立した表示bitmap。
- Fit／Zoom／PanはNative frame基準。DPR変更時は非Fitの物理倍率`scale × DPR`を維持。JPEG経路は変更しない。
- quality=draft/full、resolution、mode=whole/regionは独立。Draftはnative Quality::Draftを使い、縮小Fullで代用しない。
- view変更は表示だけ。Recipe、History、SQLite、settings fingerprint、Native mutation回数を更新しない。表示完了を保存barrierへ追加しない。
- P1のACK済みrevision採用、mutating中の採用禁止、revision逆行防止、有限courtesy、gesture終了の最終flush→History receipt→Full収束を維持する。
- 単一Session／既存native ownerで直列処理。送信済み処理はHTTP取消後もownerが回収する。cache予算とRSS/VRAM hard capは別。

## 3. 新座標契約（推奨）

Native frame `N=(Nw,Nh,aspect,geometryId)`をpixel-edge領域`[0,Nw]×[0,Nh]`と定義。aspectは実Planを正本とし、整数N寸法比との微小な丸め差をFrontendで補正しない。ViewerのB1表示rectを正本として逆写像する。

viewportを`Vw,Vh` CSS、Native→CSS倍率を`s`、Panを`px,py`とすると、画像左上は`L=(Vw−Nw*s)/2+px`, `T=(Vh−Nh*s)/2+py`。可視Native rectは`R=([−L/s,(Vw−L)/s]×[−T/s,(Vh−T)/s]) ∩ N`。空領域、非finite、s≤0では要求しない。CSSのレイアウトoffsetはviewportローカルへ一度だけ除去する。

表示に必要な仮想frame長辺候補は`E=max(Nw,Nh)*min(1,s*DPR)`。native実Planのfit規則で`F=(Fw,Fh)`を確定する（Frontend独自のaspect丸めだけで確定させない）。Native→仮想frameは`xF=xN*Fw/Nw`, `yF=yN*Fh/Nh`。可視rectをこの式で写し、margin拡張→左上floor／右下ceil→grid外向きsnap→`[0,Fw]×[0,Fh]` clampの順に整数window `W=(x,y,w,h)`を得る。加算・積はoverflowを拒否。境界は半開区間、w/hは正整数。

推奨APIは`mode=region, quality, geometryId, fullWidth, fullHeight, window`を追加し、応答に**実際に使用した**full寸法／window／bitmap寸法／quality／kind／geometryIdを返す。LCのfitが要求Fを変えた場合、座標を黙って流用せずgeometry mismatchとして再planする。最初のC段階でnative側plan検証／capability probeを追加する。legacy binaryではWholeへ有限fallbackし、Regionを送らない。

返却bitmapはWの画素だけ（w×h）。Viewer内の配置は`left=x*Nw/Fw`, `top=y*Nh/Fh`, `width=w*Nw/Fw`, `height=h*Nh/Fh`のNative rectに対して共通s／Panを適用する。例：N=3990×3000、F=N、W=(1000,800,1200,900)なら論理位置も同値。半解像度F=(1995,1500)ならW=(500,400,600,450)が同じNative領域へ配置される。丸めで得た実Fを必ず使い、requestedMaxSideだけから復元しない。

表示採用域はWの各辺から処理context量を内側へ引いた矩形。ただしWの辺がfull画像境界に一致する側はinset不要（Wholeも同じ画像外境界を持つ）。先読み量はこの内側域に含める。capで切り詰めて内側域が空になるならRegion要求を発行しない。APIはcontextと内側域も検証し、Front/Backendで別々の推測をしない。geometry再planは同ownerで一度に制限し、再不一致ならWholeへ縮退して無限要求を避ける。

orientation／crop／flip／straighten／lens／perspectiveはLC Frameが処理済み。Viewerで再回転・再cropしない。Region用geometryIdは**windowを狭める前のeffective Whole frame**から求め、window由来のcropを別geometryと誤認しない。geometry変更はWhole／Region／Before pairと候補を全面失効し、B1同様Fit再計算・Pan clamp。丸め1pxの違いは同じgeometryと同義ではなく、許容範囲はnative実Plan検証で定義する。

## 4. WholeからRegionへの選択

Wholeは最大2048の安全なbaseを維持し、Regionで高倍率の精細度を補う。2048は製品の原寸上限ではない。需要不足比を`rho=max(s*DPR*Nw/Bw, s*DPR*Nh/Bh)`（Bは**採用済み実Whole bitmap**）で評価する。native以上へ現像せず、100%超はnative Regionを表示拡大する。Fitでも高DPR／大viewportでWholeが不足すればRegion候補とする。

候補比較は、(a) rho>1で即開始、(b) 本家に近い開始1.25／解除1.10、(c) 開始1.10／解除1.0。**いずれも未採用**。CSS size、DPR、Zoom、実bitmap、可視rect、source cold/warm、CPU/DX12、PNG転送・decode、Pan要求数、メモリpeakを同条件で比較しC3で決定する。Whole要求待ちで一時的にrhoが増えただけなら重複Regionを抑える。

marginは本家4.5%＋256 gridを初期比較基準にするが、処理contextとPan先読みは分ける。描画windowは必要contextを含み、表示採用域はcontextを除く内側に限定する。先読みは内側採用域をさらに拡げる用途。予算不足でcontextを削って継ぎ目を隠す運用はしない。可視域＋contextがcapを超えた場合、Whole base＋中央の有効Regionを表示し、周辺の精細化は保証しない。複数tile並列化や無制限Wholeへのfallbackは初期工程Cの前提にしない。大viewportの全面精細化が必要なら後続の有限tile案を別途判断する。

## 5. 状態所有権・4組の要求とbounded scheduling

| 状態 | 管理責任・更新条件・不変条件 |
|---|---|
| view snapshot | ImageViewer：N、viewport、s、Pan、DPR、可視Rを原子的通知。現在RawViewへ追加が必要。JPEGは通知対象外 |
| viewGeneration | hook：Pan／Zoom／resize／DPR／geometryで単調増加。要求の採用資格。mutation revisionとは独立 |
| Region identity | document generation/token、asset、revision（BeforeはbeforeKey＋現在geometry）、quality、mode、geometryId、F、W、表示採用域、requestId。viewGenerationは配送のidentity、F/W等は再利用key |
| running/latest pending | hookとBackend：native全体で実行1＋最新plan待機1。plan内のWhole/Region/必要Beforeは有限の順序付き項目で、新planが未送信項目を置換。Beforeの独立無制限queueを作らない |
| adopted layers | hook：Whole base、Region、比較pairとURLのowner。表示revisionは全layerで逆行禁止。表示切替時に候補ownerを移す |
| source／StageCache | native：既存Sessionと有限StagePool。geometry/window/quality/source/kindを区別。Panの別windowでstage reuseを保証しない。sourceは可能な限りSession acceptで共有 |

4組（Draft Whole、Full Whole、Draft Region、Full Region）は同じintent型で明示し、独立workerを4本立てない。初回／geometry変更はWholeを先行して空白を避ける。既にbaseがある高倍率編集では最新ACKのDraft Regionを優先し、Whole Draftはその後の有限項目とする。Wholeが旧revisionなら新Regionと混ぜず、新revisionのWholeが揃うまで直前の整合した表示を保持する。これによりWhole更新コストも測定対象となる。

P1 courtesyのpreviewBusyはこの有限plan全体を含むが、既存1000ms上限を延長しない。ACK前のdesired値では要求しない。ACK後のDraftは最新desiredより遅くてもP1条件を満たせば採用可。geometry／revision／qualityの違うlayerを合成しない。gesture終了はDraft intentを失効、最終flushとHistory receipt後の同revision Full Whole→Full Regionを要求する。Full Whole時点とFull Region完了を別診断し、高倍率の収束完了は後者。保存は画像を待たない。

Pan連続入力はanimation frame単位でsnapshotをまとめ、同じ有効内側領域に収まれば既存Regionを再利用する。領域外ではlatest pendingを置換。要求間隔候補は50/100/180ms、Pan停止時に最終snapshotを必ずflushする（候補値はC3測定）。古いviewGenerationの結果は直接採用しない。ただしnative identityが同じで最新可視域が有効内側に入る場合は、最新planが同じkeyを参照する明示的再利用として採用可能。revisionやgeometryの違いをこの例外で通さない。各Panで全面失効して表示を空にしない。

HTTP Abortはwaiter／転送の取消。未送信pendingを捨てるが、送信済みNativeを強制preemptした扱いにしない。既存ownerが応答／readback／PNG検証を終了し、不要結果を破棄してから次を開始する。timeout／transport破損は既存manager回復へ接続。写真切替、generation更新、Session再生成、離脱はpending/timer/候補を回収、URL revoke、HTTP lease detach、送信済み処理のjoin／既存終了手順まで所有を維持する。複数Session並列化は不要。

## 6. 表示合成とBefore/After

単一img交換はWholeとRegionを同時に保持・配置できない。推奨はRAW限定で既存`.viewer-image-position`内にNative寸法の共通wrapperを置き、Whole img＋絶対配置Region imgを重ねる。wrapperを一度だけ共通Pan/scaleで変換し、viewportでclip、overlayはpointer-events:none。JPEGのAdjustedImageと既存img経路は維持。Canvasは合成copy／GPU資源所有が増すため初期案にしない。

Region待機・失敗でもWholeを消さない。同一revision/quality/geometry/Fの旧Regionは旧座標に保持し、Panで動く共通wrapperに追随する。新Region decode成功時に原子的交換し、旧Regionは解放する。旧位置の画像を新位置へ引き伸ばさない。context外縁をclipした有効域だけ表示し、同一条件Whole/referenceとの画素差と境界を検証する。異なるscaleのWholeとRegionはNR等の差があり得るため、marginだけで完全一致を保証しない。featherを正確性の代用にせず、残る視覚差はC3の実機受入項目にする。

Draft→Fullは同F/Wのpair単位交換を基本とし、新Full baseと新Full Regionが揃うまでは整合したDraft pairを保持する（Region未使用ならFull Wholeのみで完了）。geometry変更では旧pairを全て失効。decode失敗は旧整合pairを維持し、利用者に必要な失敗・Retry表示は残す。今回削除した正常時の常設説明を再導入しない。

Before/Afterは同じN可視rect、F、W、有効域、quality、実bitmap寸法、配置を要求し、pair keyで検証してから切替。比較中は両側共通で利用できる精細度へ揃える。Before Region未取得時はAfterを維持し既存loading/Retry、または両側Wholeが同品質ならWhole同士へ揃える。片側だけRegionを表示しない。

**異geometryは単純pixel共有不可。** 本家Beforeはcrop/orientationだけ同じでもwarp／uprightが異なり得る。初期CはB1のgeometry一致guardを維持し、不一致比較は局所エラーにしてAfterを保持する。BeforeへAfterの補正値をコピーして基準を変えない。同geometryは上記N→F写像が成立する。異geometry比較を支援する場合の規則は「After出力→After Frameのsource写像→Before Frameの逆写像→Before出力をAfterのFへ再サンプル」で、非線形warp／非可逆／欠損領域を含むnative追加契約が必要。Frontendの正規化rect共有や同寸法判定では代用不可。この拡張は初期Cの対象外とし、製品要件として必要かC0で確認する。

## 7. Region独立予算（C1検証用の推奨初期値）

以下はB1上限の無条件流用ではなく、単一RegionとBefore併用のための保守的開始案。context込み面積が満たせない場合は有限縮退する。C1の高entropy転送試験とC3の実測を通るまで製品定数にしない。

| 項目 | Region案・検証条件 |
|---|---|
| 仮想F | 実Native frame以下、各軸65536以下の候補。native fullの論理寸法であり全面buffer確保の許可ではない。極大RAWはRegion不可としてWholeを維持 |
| 出力W | 各軸2048以下、総画素2,097,152以下（context込み）。w/hの積とLC内部work windowも検査。内部拡張が予算外なら要求拒否。PNGの面積だけで処理memoryを保証しない |
| PNG／MCP | Region PNG9 MiB、Base64最大12,582,912 chars、Region MCP line13 MiB（metadata16 KiBを含む）の候補。最大RGBA8=8 MiB＋余裕。Whole line24 MiBと別のmethod-aware検証。PNG header/寸法/実decode/応答identityを全境界で検査 |
| HTTP | Region body9 MiB。既存3 leaseはWhole＋Region共通poolとし、3×17=51 MiBの既存最悪値を増やさない。Region専用poolを足さない。native/validation/転送は各1件 |
| Frontend保持 | Whole After/Before各1、Region After/Before各1、候補decodeは全種共通1。Region更新で旧1＋候補1を許すが、swap後旧を即revoke。整合pair交換に必要な候補URLはAfter/Before各1まで、decodeは直列。無制限tile cacheは持たない |
| 予算内のコピー | 採用済みWhole decoded最大32 MiB＋Region decoded最大16 MiB。交換候補pairの最大decoded追加はWhole32＋Region16=48 MiB、計96 MiB。Blobも採用Whole34＋Region18、候補同量で最大104 MiB。transfer chunks/結合/Blobは一件最大51 MiBで別途重複し得る。browser texture／Image decode内部copyは別。候補stageを早期解放し、peakを測る |
| cache key | source identity、document generation/token、revision又はBefore key、kind、quality、mode、geometryId、F/W、有効域、profile/contract version。viewGenerationだけでは画像内容cacheのkeyにしない。初期は採用pairと候補以外を保持しない |
| timeout | Region native60秒／validation10秒／HTTP90秒／decode10秒／body送信90秒を開始候補として明示。latency目標ではない。Pan連続でtimeoutを延長しない。超過時はowner回収後Wholeへ縮退 |
| native memory | P2 StageCache有限予算512 MiB（設定上限1 GiB）と既存native memory budgetを維持。source cache／shared GPU source／work拡張／CPU fallback追加量をadmissionに含める。Whole/Regionごと512 MiBを新設しない。cache拒否でも正常描画可能ならwarnで継続 |

上記Frontend数値は管理可能な面の見積りで、RSS/VRAM hard capではない。Full RAW source、native RGB32f12 bytes/pixel、StageCache実capacity、Pillow、MCP line/string/Base64/PNG、旧画像・OS textureが重なる。`retainedBytes`だけで安全合格にしない。実機peakと回収後安定値をC3で別測定する。9 MiBで収まらないPNGやwork拡張は上限を黙って緩めず、Wholeを維持して固定reasonを記録する。

## 8. 診断・失敗境界

既存構造化loggerへrequestId、mode、quality、revision、generation/viewGeneration、geometryId、F/W/有効域、pixel/byte数、queue wait／native／transfer／decode時間、cache retained/admission、gpu_success/fallback、破棄理由、Full Region収束を追加する。Pan毎clickは記録せず集計数を使う。要求/応答/古い結果はdebug、重要な開始/終了はinfo、有限縮退・geometry mismatchはwarn、必要なPreview全体が失敗した時はoperation-level error。RAW/Recipe本文、画像、URL、絶対path、資格情報は記録しない。logger失敗を表示・保存へ伝播しない。

Region失敗時は整合したWholeで閲覧・編集・保存を続け、比較失敗はBeforeローカルに留める。source decodeやtransport致命障害は既存Session回復境界を維持する。unsupported windowを高解像度Wholeへ自動切替してB1転送上限を越えない。

## 9. 推奨実装段階と受入条件

| 段階 | 実装範囲 | 完了条件／必要な自動試験 |
|---|---|---|
| C0 契約固定 | schema、座標planner、capabilityと予算、比較制約を確定 | N→可視R→F/W→配置のroundtrip、4 orientation/flip/crop/straighten/境界/nonfinite/overflow、DPR/物理倍率、aspect丸め差をfixture化。閾値は設定候補のまま。異geometry比較の初期除外を明文化 |
| C1 Native/Backend | 明示Region MCP管理patch、応答metadata、source/StagePool所有、HTTP validator/lease | 固定upstream全patch clean適用・重複/部分適用拒否、schema/kind/quality/window/実SHA receipt照合。CPUとDX12のWhole対Region crop比較（Full reference、NR/Dehaze/warp/境界）、DraftとFull別要求、Before基準維持。拒否/容量/高entropy/timeout/cancel/source回収/Session再生成の回帰。まだ通常Viewerへ有効化しない |
| C2 Frontend統合 | RAW overlay、4組intent、bounded plan、Before pair | fake API＋DOMで連続Pan中running1/pending1、古いrevision/view/geometry/decode採用拒否、被覆内再利用、写真切替/離脱URL回収、空白なし、異geometry比較拒否、同位置同精細度。P1 ACK採用/courtesy/終了Full、History/save/Undo/Redo、JPEG変化なしの関連回帰。TS/build成功 |
| C3 Windows受入・調整 | 閾値/先読み/間隔/上限の実測確定 | 下記実機計画、peak/回収、境界画質、CPU/DX12とcold/warm、Draft採用とFull Region収束を満たす値を選択。具体的latency許容値は測定基準を共有して合意。自動試験のみで受入完了にしない |

各段階は受入条件を満たしてから次へ進む。初回設計時はC0実装の前で停止した。後続C0完了記録は§11。Region patch／binary作成は次回以降の明示依頼で行う。

Windows計画：B1と同じPixel 7 Pro 3990×3000クラスDNGを基準に、原寸Whole reference（試験専用、通常HTTPとは分離）との中心/四隅/境界比較、露光・NR・Dehaze、Fit→100%→100%超、斜め/高速/反転Pan、最大化/panel、DPR1/1.25/1.5/2とモニタ移動、Before/After連打を確認する。Whole baseが消えず、Regionが画像上に固定され、継ぎ目・位置ずれ・片側だけの高精細化がないこと。gesture Draft採用率・discard理由、最終ACK/History revisionとFull Region revision、終了→Whole Fullと→Region Fullを別測定する。CPU/DX12、cold/warm、budget拒否、写真切替/再生成/離脱、長時間Pan/編集、RSS/VRAM peakと解放後安定値を測る。実driver OOM/device lossは障害注入と分け、実施可否と未実施範囲を明記する。

自動試験は変更範囲に応じNative／Backend／Frontendの境界を選ぶ。shared schedulingと永続化連携を変えるC2では関連History/save/interaction試験を含める。全suiteが必要かはそのdiffのriskで判断する。ブラウザ動的操作・NASはユーザー担当、Docker全Smokeは通常工程C開発で実行しない。

## 10. 未決定事項と対象外

- rho閾値／hysteresis、Pan集約間隔、先読みmarginとcontextの最小安全量、最大2048/2Mで不足するviewportの扱いはC1/C3で決定。upstream4.5%は全設定の厳密な誤差上限証明ではない。
- effective Frameのsource level差・自動upright差がある場合の安定したF/geometry negotiationはC1で実Planのfixture検証が必要。小さいWholeのgeometryを無検証でFull sourceへ持ち込まない。
- 初期Cの異geometry Before比較は安全に拒否。native mapping拡張、複数tileによる全面精細化、別転送形式は後続判断。比較を常に可能にする要件なら実装前にこの範囲を再合意する。
- memory／timeout初期値は予算設計案。実device/host capacityとFrontend peakを測るまで速度・RSS/VRAM保証をしない。
- RAW Exportは出力品質・色空間・保存/Stack/COVER/Album契約を持つ別工程。Region PNGをExport入力や永続cacheにしない。Scopeは可視Regionの局所分布を全画像histogramに流用せず、Whole/別集計契約を維持する。Recipe/History/DB format、JPEG Viewer、Export Queue、NAS配備は今回変更しない。

## 11. C0完了：Region契約固定（2026-10-24）

基準Commit `0b3e6127f217e1bdbb22e53ae28b093b84e8d635`。追加したコードは純planner・schema/capability/identity検証・有限plan状態遷移だけで、通常のRAW経路からimportしていない。HTTP処理、native tool呼出し、PNG生成、overlay、worker、LightCraft patch／binaryは変更しない。

### 11.1 正本とC1/C2共通fixture

| ファイル（repository相対） | 責任 |
|---|---|
| `frontend/src/rawRegionContract.json` | contractVersion=1、capability名、C1初期budget、座標演算順序、固定出力profile |
| `frontend/src/rawRegion.schema.json` | JSON Schema Draft2020-12。`$defs.request/response/frameRequest/frameResponse`がそれぞれ独立したDTO schema。未知fieldは拒否。Nativeへ埋め込む時もこのschemaを基準にする |
| `frontend/src/rawRegionPlanner.ts` | `visibleNativeRegion`、`planRawRegion`、`rawWholeDensity`。副作用なし。Fのaspect丸め・向き補正は行わない |
| `frontend/src/rawRegionContract.ts` | DTO型、構造＋意味検証、Native preflight確認、応答採否、capability検査、cache/reuse/pair判定 |
| `frontend/src/rawRegionSchedule.ts` | Promiseを保持しないdescriptorだけの有限state machine。Native workerへ未接続 |
| `frontend/src/test-fixtures/raw-region-v1.json` | C1でも再利用する固定入力／期待値。現時点ではFrontend実行のみ。Native portはこれと同じfixtureを読んで照合すること |

JSON Schemaは構造・型・field上限を規定し、積の面積上限、window包含、context inset、revision整合、要求応答の照合はTS validatorと本節の意味規則を併せて規定する。schemaだけで安全検証が完了した扱いにしない。C1は別の座標選択器を作らず、受け取ったF/W/有効域を検証して使う。Nativeの実演算検証に同fixtureを使用し、schema/budgetを再定義する場合は正本と同時更新する。

### 11.2 座標とplanner出力

入力は`geometry={nativeWidth,nativeHeight,geometryId}`、`view={width,height,dpr,scale,panX,panY}`、`full={geometryId,fullWidth,fullHeight}`、`context`、`prefetch`、`budget`。viewportとPanはCSS pixel、scaleはCSS/Native、context/prefetch/gridはFull pixel。Native寸法は正のsafe integer、geometryIdは64桁小文字hex。0/負値/非finite/unsafe integerを拒否する（Panは負値と0を許す）。geometryは最終Frameであり、sensor情報・orientation等をplannerへ渡さない。

全rectはpixel-edgeの**半開区間**。`RegionRect`は`x0/y0/x1/y1`、`RegionWindow`は`x/y/w/h`。Native可視rectは§3の共通画像左上から逆写像して画像境界と交差させる。演算はbinary64、Native→Fullは**先に乗算、その後除算**（`xN * Fw / Nw`）。逆写像も同順序。epsilon補正で境界を移動しない。

順序を固定する：

1. Native可視rectをFullへ写す（この段階はfloat）。
2. `prefetch`だけ拡張した要求域と、`prefetch+context`を拡張した描画域をそれぞれ作る。
3. 左上floor、右下ceil。
4. gridで外向きsnap（左上floor、右下ceil）。
5. Full画像境界へclamp。
6. budget超過なら下記の中央windowへ縮小。
7. 画像境界に接していない辺だけcontextをinsetし、有効表示領域を得る。

出力`mode=region`は`nativeVisibleRect`、`requestedWindow`（先読み込み・contextなし）、`contextWindow`（送信W）、`validRegion`（Full上の有効表示域）、`nativePlacement`（W全体のNative配置）、`validNativeRect`、`limited`を持つ。有効域のpixelだけを表示する。`mode=whole`は理由と、計算できた場合のNative可視rectを返す。plannerは切替閾値やcapabilityを判定せず、呼出し側が必要性を判断するための純計算である。

budget超過ではw/hを各軸上限で切り、面積超過なら短辺を維持して長辺（同値なら幅）を`floor(maxPixels/短辺/grid)*grid`へ縮める。原点は可視域中心から`floor((center−length/2)/grid)*grid`を求め、元のcontext windowに収まる範囲へclampする。画像境界でgrid非整列の端が残ることを許す。全面被覆は保証せず`limited=true`。contextは削減しない。有効域が空、又は可視域と交差しない場合はWholeへ縮退する。

固定reasonは`invalid_input`、`arithmetic_overflow`、`geometry_mismatch`、`frame_limit`、`not_visible`、`context_exhausted`、`budget_exhausted`。safe integerを越える座標演算、underflowで無限大となる逆写像も拒否。任意budgetはC1初期値より厳しい値だけ許す。閾値や大きな予算を暗黙に採用しない。

FixtureはFit／100%／100%超、中央／四隅／境界またぎ、landscape／portrait、crop後／orientation0/90/180/270後／flip後／straighten後のeffective geometry、DPR1/1.25/1.5/2、非整数scale、1px境界を扱う。異geometryには別geometryIdを与える。これらはNativeによるRAW幾何変換の画素正確性を検証したものではなく、**変換済みframeの座標契約**の試験。Native実Planとの照合はC1へ残す。

### 11.3 Fの交渉・request/response・capability

FrontendはLCのfit/roundingを再実装しない。C1用MCP能力は新tool **`render_region_preview`** の必須integer `region_contract` enum `[1]`で独立検出する。既存`preview_contract=1`や既存`render_preview` schemaを変更せず、全体protocol versionも増やさない。tool引数は`id`（既存native photo ID文字列）、`region_contract:1`、`operation:plan|render`、`target`。targetは共有schemaのframeRequest又はrequest。operationとtarget型の対応をNative側でも拒否検証する。

`operation=plan`はPNGを生成せず、frameRequestの`desiredLongEdge`（正の有限float、最大65536）とidentity/quality/geometryIdから実Native Planを調べる。frameResponseは同じ配送fieldに、実nativeWidth/nativeHeight/fullWidth/fullHeight/kindを返す。`confirmRegionFullFrame`はecho／owner／実Native寸法／geometryId／非upscale／上限を照合し、一致したFだけplannerへ渡す。問い合わせ失敗・geometry不一致はWhole維持。このNative処理自体はC1で実装する。

`operation=render`のrequestは`contractVersion:1,mode:region,quality,geometryId,F,window,validRegion,context,prefetch,identity,documentRevision,viewGeneration,requestId`。windowはplannerのcontextWindow、validRegionはFull座標の有効域をそのまま送る。responseは**実際に使用した**同fieldに`width,height,kind`を加える。実bitmap寸法はW.w/W.hと一致必須。C1はresponse metadataだけでなく実PNG header／decode寸法／quality／kindとNative readbackも照合する。echoだけで実行成功や現在revisionを認定しない。

`checkRegionResponse`は配送・owner・quality違いをstale、壊れた形やW/有効域の不一致をinvalidとする。実geometryId変更はWhole。Fだけ変更なら、初回だけ実Fを返して**再plan**を要求し、その画像は表示しない。再不一致はWholeへ縮退する。返却Fはplannerの上限/非upscale検査を再度通す。preflightしていてもrender時にsource/自動upright等が変化し得る境界を省略しない。

capabilityの純判定はmarkerとoperation、共有target schemaを検査し、不完全・不明version・重複toolは未対応とする。C1はNative generationごとに再検出し、将来のHTTP capabilitiesへoptional `regionContract:1`を公開する。未対応時はfieldを省略し、C2はRegion要求・専用UIを出さずB1 Wholeを維持する。RAW暗室全体のavailableをfalseにしない。C0の現行Backendはこのfieldをまだ返さず、既存binaryへRegionを送らない回帰を追加した。

### 11.4 密度・identity・比較

`rawWholeDensity`はNative geometry、scale、DPR、**採用済みWhole実bitmap寸法**、可視Native rectを検査し、`rhoX/rhoY/rho=max`、`sufficient`（数学的にrho≤1）、`physicalScale`、`nativeCappedRho`を返す。100%超ではrhoは増えるがnativeCappedRhoは原寸以上のdetailを要求しない。threshold／開始停止hysteresisは含めない。Fit/Zoomの別値を推測せずViewerの実scaleを使う。

content identityは`assetId,sourceId,generation,documentToken,kind`＋Afterの`revision`又はBeforeの`beforeKey`。sourceIdはBackendが割り当てる不透明な64桁hexで、path/URL/資格情報を含めず、同じsource内容の寿命を識別する（C1で生成・所有）。requestの`documentRevision`はBeforeにも持たせて配送・Native ACK検査に使い、Before pixel cacheはbeforeKeyで再利用できる。requestIdは32桁hex、counter類は非負safe integer。

`regionCacheKey`はcontent identity＋contractVersion/mode/quality/geometryId/F/W/有効域/固定`srgb-u8`を順序付き配列としてserializeする。viewGeneration/requestId/documentRevision（Beforeの場合）はcontent keyから除外。`canReuseRegion`は両DTO検証と同content owner/quality/geometry/Fを必須とし、最新可視Native rectがcached有効域に完全包含される時だけtrue。古い応答の直接採用を許可する関数ではなく、C2が最新planへ明示的に再bindするための判定である。

`regionPairMatches`はAfter/Beforeそれぞれの検証後、asset/source/generation/token/documentRevision、**geometryId一致**、同F/W/有効域/quality/実bitmap寸法を必須とする。Before keyは期待要求との応答照合を済ませてからpairへ渡す。異geometry mappingは禁止。比較不可ならAfter、又は整合したWhole比較を維持し、片側だけ精細化しない。BeforeへAfter補正値を転写しない。

### 11.5 初期budgetと有限状態遷移

**C1検証用初期budget**を定数化した。各軸2048、面積2,097,152、PNG9 MiB、MCP line13 MiB、metadata16 KiB、仮想/Native各軸65536、grid256。製品確定値やRSS/VRAM hard capではない。context／prefetchの量は入力であり既定の4.5%等をコードへ採用していない。既存Whole PNG17 MiB／line24 MiBと別modeのvalidationで扱う。内部work拡張と実capacityの検査、実PNG/MCP読出し制限はC1実装であり、今は純validationのみ。

有限planは最大**6 descriptor**：After/BeforeそれぞれWhole render、Region preflight、Region renderの各slotを最大1件。quality・document revision・viewGenerationとownerはplan内で揃え、Before keyとRegion geometryIdの混在も拒否する。preflightも同じrunning slotを使い、別workerを作らない。descriptorは未確定Fのplaceholderを許さないため、preflight結果が必要ならまずqueryだけを送信し、その結果と最新viewから**新planを組み直す**。最大6はqueue descriptor数であり、6枚の画像や6 Native同時実行を許す値ではない。

`replacePreviewPlan`は単調増加planGenerationで全未送信itemを置換、`takePreviewItem`はrunningが空の時だけpending先頭を移す。`finishPreviewItem`はplanGeneration/requestId一致時だけrunningを解放。invalidateはpendingだけを捨て、送信済みrunningは完了まで所有する。古いplan到着は無視。呼出し元入力はsnapshotして保持し、無限Promise列やappend queueを持たない。

C2ではこのdescriptor遷移に既存owner/readback/ACK採用/gesture/geometry/save guardを接続する。`take`は実行可能性を判断するdispatcherではない。mutating/未ACK/保存barrierの既存guardを通過してから送信する。P1 courtesyの1000ms上限、ACK済みDraft採用、終了Full、History receipt、画像を待たないsaveを変更しない。HTTP cancelは未送信破棄とwaiter detachでありNative preemptionではない。C0はworkerへの接続も送信も行わない。

### 11.6 残る確認とC1開始条件

- **C1必須確認：** 固定v0.10.0実Planによるpreflight/F安定性、source level/自動uprightの差、contextとwork windowの最大範囲、CPU/DX12のWhole対Region画素比較、StagePool/source所有、PNG高entropy転送、schema/kind/qualityと実binary receipt。C0のJSON fixtureをNative側でも同一期待値で通す。既存patchの全適用・重複/部分適用拒否は更新guideどおり必要。
- **C2まで未実装：** RawViewへPan/可視域を追加、capabilityのHTTP公開・UI利用、有限planと既存ownerの統合、Region送信・decode・overlay、pair切替、URL回収。現行ViewerはB1 Wholeのまま。
- **C3で決定：** rho開始/解除threshold、Pan集約間隔、context/先読み量、予算の製品採用値、latency受入値とRSS/VRAM peak。C0初期定数は実測結果を先取りしない。
- **C1開始条件：** C0契約・fixture・限定監査に未解決High/Mediumがなく、ユーザーからC1開始の明示依頼があること。C1はNative/Backendのみから始め、通常Viewerを有効化しない。今回C1には進まない。

### 11.7 検証・限定監査結果

Frontend関連8ファイルは最終成功300件（C0最終77＋変更のないB1関連223、再実行の重複を加算しない）。Backendは新規のRegion未送信/Whole維持回帰と既存adaptiveの2ファイル43件。TypeScript込みproduction build成功、`git diff --check`実施。既存500 kB超chunk警告あり。初回sandboxのFrontend一時cache ENOENTとBackend一時dir作成失敗は通常環境で再実行して解消した。C0の試験は純関数／DOM／fake native境界であり、Native Region実装やWindows実機の成功を示さない。全suite、ブラウザ動的操作、LightCraft patch変更／Region binary buildは実施しない。

限定監査は座標単位・順序・上限・未知mode、schema/DTO意味検証、独立capabilityとB1 fallback、Before/After identity、Pan reuseと配送staleの分離、running回収とpending上限、既存P1/History/save/JPEGへの接続有無を確認。unknown modeとplan内のBefore key／Region geometry混在を拒否するguardを追加し、影響範囲を再検証した。**未解決High0／Medium0／Low0**。既知のC1/C2未実装とC3候補は監査済み実動作ではなく後続工程の受入条件として残す。C1開始は明示依頼待ちで、C0で停止する。


## 12. C1完了：Region Native/Backend（2026-10-25）

基準GenzoRoom `e0e442c41ef7205690a5047750110d67f11531ce`。固定LightCraftは引き続きv0.10.0 / `a2a41383c4fd62fa85a46ccd00998639221f2d3c`。§11のschema・座標fixture・契約値を変更せず、管理patch内の独立tool `render_region_preview` とBackendの未接続adapterを実装した。通常暗室はB1 Wholeのまま。以下はC1の実装・検証記録であり、§1〜11の過去時点の未実装記述を更新する。

### 12.1 実Plan・source・window

Nativeは `region_contract:1` / `operation:plan|render` / 文字列photo `id` / `target` を厳密検証する。未知field/version、operationとtarget型の不一致、非finite、integer/overflow、identity、F/W/validRegion/context/prefetchをfail closedで拒否する。C0 schema・定数・座標fixtureをNativeへ同一内容で取り込み、build時にFrontend正本およびBackend schemaとの一致を検証する。独自のsensor座標変換は追加しない。

planはPNGを生成せず、実sourceとeffective settings/uprightからLC共通pipeline Planを作り、window適用前のB1 frame metadataと同じgeometryId、Native寸法、実Fを返す。Frontendのfit/rounding推測には依存しない。論理Native frameに対して非upscaleを確認し、overscan cropでNative frameが物理sourceより広がる場合も物理長辺で早期制限しない。実試験では2048×1536→F2048×1536、Full source3072×2304→F2800×2100を確認。合成source選択試験はThumb512 / Preview1536 / Full2600、自動upright、source aspect/analysis不一致を含む。render時のgeometry/F不一致は固定 `region_geometry_mismatch` で拒否し、別windowへ黙って変更しない。C2はWhole維持または再preflightする。

renderは既存 `region_job` / `region_job_before`、`Frame::window`、共通CPU/GPU Planを利用する。要求W、内部work W、実出力Wを区別し、workの包含・Full境界・各軸/面積上限を実行前に検査する。遠距離spot等の拡張が収まらなければ `region_work_budget_exceeded`。context削減や出力縮小による成功扱いはしない。responseは実jobのquality/kind、実Planのgeometry/F、実jobのW、実PNG寸法を返す。carrierは `{response, diagnostics}`、planは一致するtext/structuredContent、renderはimageとtextである。

preflightによるDevelop/History変更を避けるためsource受入は画像cacheのみ。cold RAWで未登録as-shot WBを通常renderが学習する必要がある場合、その前にcacheして通常学習を飛ばさない。WB回帰とsettings不変を試験した。Beforeはimport baseline/beforeKeyを維持し、Afterのexposureを転写しない。Before/After FullとDraftの実F/W/bitmap寸法一致、画素の相違を確認した。異geometryのmappingは実装しない。

### 12.2 Whole Fullとの画素比較

合成linear RGB・合成RAW SourceInfoを用い、CPU/DX12それぞれ中央・四隅、画像境界、crop、0/90/180/270、flip、straighten、exposure、NR、Dehaze、perspective/distortion、local maskを比較した。全150比較。これは実RAW decoderによるカメラ機種別受入ではない。値は8bit RGBの絶対差（LSB）、innerはcontextを除いた有効域である。

| 条件 | CPU / DX12結果 |
|---|---|
| 基本補正・geometry・local・RAW info | 有効域最大差0〜1。多くは完全一致 |
| NR context24 / 64 | 有効域最大差1以下。context64のDX12は0。外周を含む最大差5 |
| Dehaze context24 | 有効域最大差3、最大平均差CPU0.043811 / DX12 0.043764。外周を含む最大差13 |
| Dehaze context64 | 有効域最大差3、最大平均差CPU0.041043 / DX12 0.041088。外周を含む最大差8 |
| 実release binary、2048×1536 noise、512×384 Region/context64 | CPU/DX12ともWhole Full cropとの有効域最大差0 |

Dehazeの有効域差はcontext増加だけでは消えない。固定upstream `pipeline/src/lib.rs` の `AIRLIGHT_PROXY_EDGE=384` によりwindow経路はWhole proxyからairlightを得る一方、通常Wholeはfull-frame統計を使う。全画像をWとしたwindowでも通常Wholeに対して最大差3を再現し、同じproxy経路のreferenceとのRegion有効域差は最大1。外周の空間filter差も別にある。upstream `tests_window.rs` は空間処理/Dehazeに非zero許容差を持つが、その許容値をGenzoRoomの製品基準として採用していない。**Low：Dehazeのoverlay境界に微小な色差が出る可能性**を残し、C2の表示方針・C3実測で判断する。完全一致やcontextだけで解消すると主張しない。GPU成功の実測に加え、GPU OOM注入によるCPU fallbackと回復をNative試験で確認した。

### 12.3 所有・budget・transport

WholeとRegionは同じHeadless StagePool、512 MiB finite予算とP2 capacity admissionを共有し、別Region cache予算を追加しない。cache OFF/ONのFull PNG一致、tiny budget拒否後の描画継続、Whole→Region→Whole、Region反復/異なるwindow、Draft→Full、Before/Afterを確認。window変更時の空間stage再利用は保証しない。

実probeのretainedBytesはCPU43,253,760 bytes（41.25 MiB）、DX12 81,002,496 bytes（77.25 MiB、CPU36 MiB＋GPU41.25 MiB）。選択sourceのhost capacityは2048×1536で37,748,736 bytes（36 MiB）、3072×2304 Fullで84,934,656 bytes（81 MiB）。sourceのallocation ownershipを維持し、media cache計上とStagePoolのcapacity診断を区別する。未cache Full decodeは物理source pixels×36の保守予約を既存Native memory budgetへ照合してから開始する。これらは**RSS/VRAM peakやhard capの測定ではない**。実RAWのdecode peak・driver OOM/device lossは未受入。

C1初期検証budgetはNative/virtual各軸65536、要求/内部work各軸2048、面積2,097,152、PNG9 MiB、MCP line13 MiB、metadata16 KiB。製品確定値ではない。NativeはPNG stat/readをbase64化前に制限し、JSON ToolResult＋4096 bytesのenvelope予約も確認する。Backendはmethod/operationごとのread上限とresponse ID別上限、base64/PNG/header/CRC/decode/metadata/実寸を再検証する。planは通常1 MiB transport枠。WholeのPNG17 MiB / line24 MiBは維持する。

高entropy2048×1024 Regionの実PNGは6,293,375 bytes、base64＋metadata＋4096の保守envelope見積りは約8.40 MBで、実13 MiB制限のreaderを通過した。これはline実測値ではない。9 MiB超PNG拒否をNative fake-backend/file境界で、13 MiB超line拒否をBackend transportで自動試験した。面積上限内のRGBA8 entropy PNGが必ず9 MiBを超えるという前提は置かない。

### 12.4 Backend境界・配送・旧binary

`raw_region.py` がC0 schema/意味検証とNative carrierを検証する。schemaはfrozen Backendのdataにも含める。generationごとの独立capability検出と `/api/raw/capabilities` のoptional `regionContract:1` を追加した。旧B1実EXE（SHA `09d38369d4cbe0274fe363862d139097be063845f65a31a2bbd3931d4357a02e`）ではRegionを送らずunsupportedとなり、その後もWhole Full成功・Session readyを確認した。不完全capabilityは省略し、WholeのavailableをRegion未対応だけでfalseにしない。

`LightCraftRawSession.request_region` は未接続の内部境界。既存worker/native lock/validation threadへ合流し、running 1、未送信latest pending相当で置換する。Region Beforeも同じpending枠を使う。既存legacy Whole Beforeの独立pending挙動は変更しない。100 view置換、cancel後readback/validation回収、timeoutでprocess終了、旧generation拒否、reset/photo change/shutdown joinを試験した。Region専用worker/Session、HTTP Region routeは追加しない。

sourceIdは既存source content hashから構築する不透明64桁ID（§14.8の修正を参照）、generation/revision/beforeKeyは既存ownerから構築・照合する。内部RawHandle tokenとHTTP公開document tokenは異なるため、将来のHTTP ownerが検証したtokenだけを明示的にadapterへ渡せる境界を設けた。省略時は内部tokenで照合する。**C2は公開documentのowner/leaseを先に検証し、source identityを必要なDTOへ安全に公開してから接続する責任を持つ**。現行routeの `mode:region` は拒否のまま。structured diagnosticsはoperation/quality/kind/revision/generation/geometry/F/W/valid/requestId、native/validation時間、PNG bytes、source容量、execution/cache/rejectを扱い、path・画像・Recipe本文を記録しない。

### 12.5 配布物・検証・限定監査

- release EXE：`I:\code\genzoroom\.tmp\lightcraft-c1\target\release\lightcraft-cli.exe`
- binary SHA-256：`2c7b7f01e366c56151dedffa0fc2b2af3496a035e3bba5a384a3fdcc1ac26812`
- 管理patch digest：`e00ef2754b072076c54da746f145d7edbd87b331fa557f9ca38fd9b5948cc26e`
- 隣接 `lightcraft-cli.genzoroom.json`：固定upstream commit・patch digest・実binary SHA・beforeContract/previewContract/regionContract各1。旧B1 EXEは変更しない。

固定upstreamへのclean apply、全diff一致、重複適用拒否、共有artifact一致を確認。管理buildのNative MCP試験66成功・既存ignore1、e2e10成功。Region7試験には共有fixture、150画素比較、source/work/geometry/quality/Before、GPU fallback、PNG上限、cold RAW WBを含む。release CPU/DX12 probeとreceipt/SHA再probeを実行した。

Backend関連10ファイルの成功267件を基礎に、Region最終追加2件で同ファイルを15件再実行、patch管理4件も再実行した。重複除外で関連成功269件。Frontend純planner/contract/schedule/APIの4ファイル136件成功、型検査込みproduction build成功（既存500 kB超chunk警告）。Python構文検査と `git diff --check` を実施。全suite、PyInstaller配布build、Docker Smoke Test、ブラウザ動的操作、通常ViewerのRegion実機確認は行わない。frozen schema同梱設定は自動試験で確認し、変更不要のrelease smoke期待値も確認した。

限定監査はgeometry/source/window/work/overflow、PNG/MCP bounds、CPU/GPU、共有StagePool、Before baseline、cancel/cleanup、旧binaryとsettings不変を対象とした。cold RAW WB学習の抑止、実metadataのecho依存、論理Native frameの早期制限を修正して再検証した。**未解決High0 / Medium0 / Low1（上記Dehaze画素差）**。

**C2開始条件：** C0/C1契約・共有fixture・実binary receiptを維持し、明示的なC2依頼を受けること。C2実装へ進める状態だが、Dehazeを含むoverlayの画質受入は未完了。C2ではpublic owner/lease、有限plan、ACK済みrevision、stale/readback、URL回収、同geometry pairを接続し、P1 courtesy/gesture終了Full/History/saveを保持する。C3はthreshold、context/prefetch、集約間隔、製品予算、latency、実RAW/RSS/VRAM実測を決める。C1ではViewer overlay、Pan送信、自動Region切替、Export、Scopeを実装せず停止する。

## 13. C2-A完了：Region配送・所有・状態管理（2026-10-25）

基準はC1完了 `e651a68179c91f348f9b321ea7c59a17b38ecb5b`。Native/schema/plannerの契約とbinary receiptは変更していない。

### 13.1 HTTPとpublic owner

`GET /api/raw/documents/{handle}/region` は既存workspace/generation/public tokenのheaderを照合し、source content hashとoptional capability（1又はnull）だけを公開する。通常Viewerからは呼ばず、`useRawDocument.connectRegion()` が明示接続する。

`POST .../region` のJSONは `{workspaceId, operation:plan|render, target}`。targetはC0/C1 schemaそのもの。workspace、公開handle、asset/source、generation、公開documentToken、documentRevision、kind/revision又はBefore keyをownerで照合し、検証済み公開tokenを必ず `document_token=` へ渡す。Native lifetimeは内部RawHandleが所有する。Wholeが確認した公開geometryとNative geometryの対応をkind/quality別の最大4枠で保持し、現在revision/geometryの対応がある場合だけNative DTOへ変換する。新document／closeで破棄する。公開geometryをNative geometryとして送信しない。

operation=planはJSON metadata、renderはimage/png bodyと `X-Raw-Region` のmetadataを返す。metadataにはidentity/revision/requestId/viewGeneration/quality/kind/geometry/F/W/validRegionが含まれる。C1のowner workerがNative readback、response identity、geometry/F/W/validRegion、実PNG寸法・CRC・decodeを再検証してからHTTPへ渡す。RegionはPNG 9 MiB／MCP line 13 MiBのまま、Wholeの17/24 MiBを変更しない。送信前のgeometry不一致は `raw_region_geometry_mismatch` でWhole維持・再preflightへ戻す。古い応答は204又はidentityを含むmetadataとして識別できる。

### 13.2 lease・取消・lifecycle

RegionとWholeは既存の3 image lease枠を共有する。未送信Region pendingの置換はticketを完了して枠を返し、bitmapを保持しない。PNG応答が完成した枠はASGI送信完了までresponse leaseとして同じ集合内で追跡する。送信は既存の90秒timeout内で、正常・失敗・取消のfinallyが枠を返す。document/workspace closeとshutdownは送信中responseの終了を待ってからsession/sourceを解放する。

`POST .../region/cancel` はworkspace/generation/public token/requestIdを照合する。HTTP取消はwaiter detachであり、pendingは破棄、running Nativeはreadback/PNG検証/cleanupまで既存workerが回収する。取消は送信時のRawHandle/public documentを保持し、後継generationへ向け直さない。Native timeoutは既存manager回復境界へ入り、旧generationは再利用しない。

Frontend ownerはasset切替（Filmstrip含む）、Gallery復帰／unmount／pagehide、session再生成、revision・geometry・owner変更、mutation、表示失効でpending、候補、preflight、HTTP controllerを回収する。送信中promiseはfinallyまで1件だけ保持する。Regionのobject URLは生成せず、候補Blobはownerから参照を外す。独自timer、Native worker、lease poolは追加していない。

### 13.3 finite planとC2-Bへの受渡し

`RawRegionDelivery` がC0 `rawRegionSchedule.ts` を実行する。`useRawDocument.regionDelivery` から `owner`（doc/sourceId/capability/geometryとavailability）、`state`、`submit(plan)`、`candidate`、`preflight` を取得できる。ownerはsnapshotとして公開する。planGenerationは同owner内で単調増加させる。document再生成ではviewの下限をresetし、planGenerationの下限はstateから継続する。

running promise 1＋latest pending plan 1（最大6 descriptor）。未送信tailは新planで全置換し、running完了後に最新tailだけ進める。preflightが完了すると旧tailを破棄し、確認されたFを使った新planの明示submit、又はowner constructorのreplan callbackで再構築する。preflightとrenderは同じrunning slot。Whole descriptorも同じRaw APIへ送り、hookでは既存frameSerialを共有する。

asset/source/generation/token/revision/geometryと最新plan/viewGeneration、request単位のC0 response検証を全て通った結果だけcandidateになる。quality/kind/F/W/validRegionもAPIで検証する。mutating/unsettled/frozen/save lock時には開始・採用を禁止し、既存Whole running/pendingを優先する。Whole側の新しい表示意図はRegionを失効させる。HTTP取消後もNativeの共有worker/lockは直列なのでNative runningは1。P1 courtesy最大1000ms、gesture終了Full、History receipt、save queueは変更せず、saveからRegion画像を待たない。

古いRegionを直接採用・再利用しない。viewGenerationは配送identityのまま、content cache keyへ追加しない。C2-Bがreuseを実装する際は `canReuseRegion()` と最新planへの明示rebindが必要。Before/After候補pairの保持・採用とoverlay URL生成はC2-Bの責任。

### 13.4 fallbackと診断

regionContractなしでは明示接続がunsupportedを返し、有限planを開始しない。BackendもNative送信前にcapabilityを確認する。Whole availability、既存Whole route、通常ViewerのB1挙動を保持する。C1 binaryでも通常ViewerはRegionを要求しない。

既存構造化loggerでplanGeneration/requestId/operation/viewGeneration/revision/quality/kind/geometry/F/W/validRegion、queue wait／response wait／body read／validation、accepted/stale/superseded/cancelled/failed/capability_missing/geometry_replan/whole_fallbackを追跡する。queue/配送はFrontend、Native/readback/検証はC1 Backend、HTTP採用はpublic ownerの診断境界。Pan入力ログ、Recipe本文、path、画像、資格情報を追加しない。logger例外は動作を変えない。

### 13.5 自動検証・限定監査

Backend関連8ファイル161件が成功。対象はC0/C1 Region契約・carrier上限、public owner spoof、公開tokenの明示attestation、plan/render、response mismatch、共有Native running=1、100回pending置換、waiter取消、lease、timeout、generation変更、応答送信中close/shutdown、Whole/Before/P1/History/Recipe。追加のHTTP配送試験は17件。Nativeを模した既存fixtureを使う自動試験であり、今回実binaryを起動した検証ではない。

Frontend関連12ファイル332件が成功。その後のowner取消・mutation候補回収修正と送信時owner回帰追加後、関連6ファイル135件が成功。C0 planner/fixtures、API validation、preflightから新plan、100回置換、stale owner/revision/view、abort、capability fallback、hook明示接続・photo離脱、P1/History/saveを確認した。TypeScriptとproduction build成功。既存の500 kB超chunk警告は残る。サンドボックスのTEMP読込・疑似Native制限はrepo内TEMP指定とBackendの権限付き同一Python 3.14実行で解消した。全suite・Docker Smoke Testは実行していない。

限定監査対象はowner spoof、lease leak、Native並列化、stale採用、取消、generation crossing、pending増加、旧binary fallback、P1/History/save。取消が後継documentを参照する競合とmutation開始時の候補回収を修正し、回帰試験を追加して再監査した。response lease登録もtask完了callbackからdocument lock内へ移し、closeがcallbackより先に再開する隙間を閉じた。最終修正後のBackend HTTP/Whole/P1関連3ファイル82件が成功。未解決High/Mediumなし。C1のDehaze最大3 LSB差は継続課題で、今回の表示受入結果ではない。

### 13.6 C2-Aで実装しない表示機能と開始条件

Region overlay、Wholeとの合成、ImageViewer DOM変更、Pan/Zoomからの要求、自動Region切替、rho threshold、context/prefetchの製品確定、Before/After Region UI、Dehaze視覚調整、C3性能調整、RAW Export、Scopeは未実装。ブラウザ・Windows実画面・NAS/Firefox・実RAW/GPUでのC2配送／memory測定は未実施。

**C2-B開始条件：** この配送owner/APIとC0/C1 schema/fixture/receiptを維持し、明示依頼を受けてから開始する。C2-Bでは最新viewによるpreflight再plan、候補pair/URL、overlay placementとcleanupを実装し、WindowsでDehaze境界を含む表示受入を行う。C2-Aはここで停止する。

## 14. C2-B実装完了：Region Viewer overlay統合（2026-10-25）

基準Commitは `d12b38869538993700ea785e009d661e592256a5`。C0契約／planner／fixture、C1 Native binary、C2-A HTTP/public owner/leaseを維持し、Frontend表示所有を接続した。ここでいう完了は実装・自動試験・開発buildの完了であり、Windows実画面受入はユーザー確認待ちである。

### 14.1 DOMとNative placement

RAWかつnative frameありの場合だけ、既存 `.viewer-image-position` の内側に `.raw-native-frame` を置く。Whole baseはframe全体を覆い、Regionは同じwrapper内のabsolute img。Panは親の共通translate、scaleはNative寸法とplacementへ同じCSS倍率を一度だけ適用する。JPEGのAdjustedImage／通常img分岐は維持し、ImageViewerはAPI・request生成・schedulerを所有しない。

`regionLayerPlacement()` はC0 `regionNativeRect()` でresponseのF/window/validRegionをNativeへ写像する。bitmap全体をnativePlacementへ配置し、validNativeRectとの差をCSS inset clipへ渡す。bitmap naturalWidthやrequestedMaxSideから位置を推測しない。contextは表示せず、feather／blur／境界隠しは加えない。Before/Afterは既存の同位置img切替方式のまま、WholeとRegionを同じwrapperで切り替える。

### 14.2 表示ownerとURL

`RawRegionOverlay` はC2-A配送イベントをsubscribeする。Reactが複数応答を同じrenderへまとめても、After候補をBefore候補で失わない。送信plan内のdescriptorを最大6件で記憶する `RawRegionDelivery.isCurrent()` が、planGeneration、viewGeneration、requestId、owner、revision、quality/kind/geometry/F/W/validRegionを再検証する。URL生成前とdecode後、Whole到着後の採用時に再照合する。

decodeは同時1件。未decodeの最新候補はWhole/Region×After/Beforeの4固定slotで、PNG URLを持たない。decoded候補は各側最大1件、採用Regionも各側最大1件。新しい同側decodeを始める際に同側の未採用候補を置換する。失敗／staleは候補URLだけを回収し、整合した旧表示を維持する。owner変更時はpending／staged／採用済み／decode controllerを全失効する。

`RawPreviewUrls` の参照数でWholeのUI所有とoverlayの保持を分離する。新Wholeが来ても、旧整合pairが参照するbase URLは生存する。採用時に両baseを保持してから旧pairを解放する。再試行がUI参照をretireした後のURLは採用せず、現在生存するbaseを待つ。Region交換、decode失敗、asset/generation/token/revision/source/geometry変更、mutation、Before終了、再生成、Gallery/unmount/pagehideで回収する。Blob URLをログへ出さない。

### 14.3 Draft/FullとBefore/After

WholeとRegionは同owner/document revision/geometry/Native寸法/quality/Fを必須とする。Full Whole先着又はFull Region先着のどちらも、旧Draft pairを保持する。必要なFull WholeとFull Region（比較中は両側）が揃って初めて一括交換する。異revision・異qualityの重畳はしない。Region失敗／未使用時はWholeを維持する。

比較中は `regionPairMatches()` に加え、同plan/viewと両側のWhole整合を要求する。W/validRegion/F/quality/bitmap寸法/geometryの不一致は採用しない。Afterだけ採用済みで比較を開始した場合は、それを外して両側Wholeへ戻す。片側Regionだけの比較を許可しない。比較終了時にはRegion表示所有を回収する。

既存B1 Before bitmapはbeforeKeyが不変ならAfter revisionを跨いで再利用できる。新After Wholeのreadback・decode確認後、同asset/handle/generation/token/beforeKey/geometry/qualityの場合だけ、Before Wholeのreceipt revisionを現在docへ明示rebindする。これは既存Whole baselineの扱いであり、古いRegion responseの復活ではない。明示Whole descriptorのBefore serialも既存beforeSerialを共有する。

Regionのreuse用 `rebindRegion()` はC0 `canReuseRegion()` を通し、最新可視Native rectがcached valid域に包含されるときだけ、新plan用request/responseを返す。bitmapの元W/validRegionを保持し、配送requestId/viewGeneration/documentRevisionだけを明示更新する。自動reuseやPan接続はしない。

### 14.4 明示diagnostic trigger

Developer Diagnosticsの「RAW Region Preview」tabが選択された間、同一WebView群の診断BroadcastChannelから現在のRAW ownerへ明示操作を送る。RAW ownerはtab attach時だけRegion capabilityを確認し、ボタン操作以外ではRegion requestを発行しない。UIは位置名を送り、Native frameの半幅・半高から可視矩形を算出する。context=16 / prefetch=0はDeveloper Diagnostics専用の固定試験値で、製品値ではない。Pan/Zoomは監視しない。

`window.genzoroomRegion` は旧来のopt-in内部manual triggerとして残すが、Windows受入では使用しない。通常暗室UIにRegion診断ボタンを追加せず、Developer Diagnostics tabを開いていない通常利用の動作を維持する。

表示整合の確認用なので、preflight Fは現在Whole Fと同じであることを要求する。Whole／Beforeの必要なbaseがない場合は失敗又は待機し、Regionだけを先行表示しない。`status()` はWhole frame/quality、Before準備、planとoverlay metadataを確認できる。`clear()` は配送・overlayを失効させ、Wholeを残す。owner離脱時にはglobal triggerも削除する。

診断eventは `region.overlay.*` にcandidateCreated、decodeStarted/Completed/Failed、adopted、replaced、stale、revoked、pairWaiting/Adopted/Rejected、geometryMismatchを記録する。revision、qualityと実表示Whole quality、geometry/F/W/validRegion、Native placement、plan/view/request IDsを持つ。通常cancelのdecode中断はstale/debug、decode異常・pair不一致・geometry不一致はwarn。logger失敗は表示動作へ伝播しない。

### 14.5 自動試験と限定監査

関連17ファイル526件の初回確認は525成功／1失敗。失敗は既存 `AnshitsuPersistence.test.tsx` の `switches after a successful PUT for a numeric adjustment edit` で、Exposureをrangeのindex 2で選ぶ試験の値が期待0.5に対し1だった。同じ試験を単独実行して再現し、作業ツリーを変更せず基準CommitのFrontendを隔離展開した環境でも同じ失敗を確認した。今回範囲外の既存試験課題として残し、JPEG実装や該当試験は変更していない。

最終監査修正後は直接関連9ファイル292件が成功。対象はC0 fixtureの中央・四隅・edge・crop/portrait/landscape・DPR・非整数・丸め境界、Native placement、decode保持と失敗・交換、各種stale、100回URL交換、Full Whole/Region到着順の両方、Before pair不整合、明示Whole descriptor、hookの比較／revision rebind／pagehide／離脱／mutation、P1/History/save、JPEG/Whole Viewer。TypeScriptとproduction build成功。既存500 kB超chunk警告は継続。

Windowsホスト `cargo build --manifest-path desktop/Cargo.toml --locked` 成功。hard-link非対応のincremental cacheをcopyへ切り替える警告のみ。指定C1 EXEの実SHA-256と隣接receipt（beforeContract/previewContract/regionContract各1）を確認し、Native再build・実RAW処理は行っていない。Backend/API/schemaを変更していないためBackend suiteは再実行していない。全Frontend suite／Docker Smoke Test／ブラウザ動的検証は未実施。

限定監査はrevision混在、geometry placement、stale decode、URL leak、片側Before、Draft/Full混在、JPEG、ImageViewer責任、通常操作からの自動要求を対象とした。decode待機中にpair片側を失わない固定slot、Before serial共有、旧baseの参照保持、retry後のretired URL拒否、Before baselineのreceipt rebindを確認・修正して回帰試験を追加した。再監査の未解決High/Mediumは0。上記の既存JPEG試験失敗とC1 Dehaze最大3 LSB差は残るが、今回のコード回帰とは区別する。

### 14.6 Windows実画面受入手順

Frontend production buildとWindows開発hostは作成済み。既存プロセスはユーザー側で保存・終了してから、PowerShellで起動する。保存済みImmich設定とWindowsPoC profileを従来どおり使う。

```powershell
Set-Location I:\code\genzoroom
$env:GENZOROOM_LIGHTCRAFT_EXE = 'I:\code\genzoroom\.tmp\lightcraft-c1\target\release\lightcraft-cli.exe'
# 実SHA: 2c7b7f01e366c56151dedffa0fc2b2af3496a035e3bba5a384a3fdcc1ac26812
& '.\desktop\target\debug\genzoroom-desktop.exe'
# 作り直す場合は frontend で npm run build、その後rootで cargo build --manifest-path desktop/Cargo.toml --locked。
```

以下の操作はDeveloper Diagnostics UIだけで実施できる。任意JavaScriptやWebView2 Consoleの入力は不要。

1. Windows版GenzoRoomを起動する。
2. Immich GalleryからRAWを暗室で開き、Whole Fullの準備が完了するまで待つ。
3. 設定からDeveloper Diagnosticsを開き、「RAW Region Preview」tabを選ぶ。capability確認後に「Region対応」「準備完了」、Quality「Full」となり、位置buttonが有効になることを確認する。最初のRegion要求前はgeometry「未確認」で正常。RAW未接続、Region非対応LightCraft、Whole Full待ちの場合はUIの案内に従い、ボタン要求は送信されない。
4. 「中央」を押す。Regionが画像のおよそ中央半分へ表示されること、Whole geometryとRegion geometryが一致し、Region表示サイズとQualityを確認する。context=16 / prefetch=0はこの診断UI内だけで使うC2-B試験値で、製品値ではない。
5. 「左上」「右上」「左下」「右下」を順に押し、続けて「左端」「右端」「上端」「下端」を押す。各rectは現在のNative frameから自動計算され、ユーザーの座標入力は不要。中央・四隅・edge、crop/portrait/landscape、DPR1/1.25/1.5/2、非整数zoomでRegion位置とvalid域境界・Whole保持を確認する。Pan/Zoomだけでは新Regionは要求されない。
6. Before画像を暗室の既存Before表示操作で準備する。Developer Diagnosticsの「Before/After Region比較」をONにして、Before準備状態がFullになるのを待ってから位置ボタンを押す。Before未準備中は要求を送らない。比較中は両側Regionが揃うまでWhole、揃った時だけRegion pairとなり、切替位置が一致することを確認する。
7. 必要に応じて診断UIの「有効境界を細枠表示」をONにし、通常OFFの細い枠で1px整合を確認する。Dehaze有無で境界も見る。feather、blur、境界補間は適用しない。
8. 「Region解除」を押し、Regionが消えてWholeだけになり、解除済みが「はい」になることを確認する。
9. Developer Diagnosticsを閉じ、RAW photoを切り替え、Galleryへ復帰する。それぞれで旧Regionが残らず、診断接続が解除されることを確認する。decode失敗時にもWholeが消えないことを確認する。既存Developer LogsでFrontend levelをdebugにすると配送・overlay eventを確認できる。

### 14.7 C2-Cへの受渡しと未実装

この節はC2-B実装時点の受渡し記録である。C2-C実装後の状態とWindows受入結果は§15〜§17を正本とする。

`regionDelivery.submit/isCurrent/subscribe`、`regionDisplay`、表示ownerの有限URL/pair所有、`regionLayerPlacement`、`rebindRegion`、明示preflight helperを渡す。C2-C開始は別の明示依頼とWindows overlay受入を条件とする。実画面の1px整合、実RAW/GPU、Dehaze境界、長時間RSS/VRAMは未受入。

Pan/Zoom自動Region要求、rho threshold、context/prefetch製品値、Pan集約間隔、Region product budget、latency/RSS/VRAM受入値、Dehaze差の製品許容、C3調整、RAW Export、Scopeは未実装・未決定のまま。C2-Bではこれ以上進めない。

### 14.8 Windows owner取得失敗の原因と修正

基準 `48e10fe7931fe29081da1f31828b6c5885728ece` のWindowsログはgeneration 2 / revision 4のWhole Full 1024、1472×1107、DX12 gpu_successとFrontend decode成功を示すが、owner GETの観測がなく失敗境界までは判定できなかった。実C1 EXE（SHA-256 `2c7b7f01e366c56151dedffa0fc2b2af3496a035e3bba5a384a3fdcc1ac26812`、receiptのbefore/preview/regionContract各1）をprobeし、実tools/listのRegion toolが1件あり、Backendの厳密`supports_region()`がtrueとなることを確認した。schemaは原因ではない。

実photo.inspectのcontent_hashはNative Hash128の32桁hexだった。Backendの`region_identity()`がこれを未変換でsourceIdへ返していたため、GETがHTTP 200でもFrontendのC0 64桁検証で`raw_invalid_response`になる。fake Nativeは64桁SHA-256を返していたので従来試験では露出しなかった。32桁を使うHTTP回帰試験を修正前に失敗させ、原因を再現した。

sourceIdを`SHA256(ASCII("genzoroom-region-source-v1") + NUL + ASCII(lowercase_native_content_hash))`で導出する。domain区切りはNUL byte 1個である。これはNativeの内容識別子からの不透明ID導出であり、RAWファイル自体のSHA-256やNative hashの衝突強度向上を意味しない。GETとRegion request所有検査は同じ`region_identity()`を使う。C0 schema、Frontend検証、public owner/token検証は緩めず、永続形式も変更しない。

Frontendには`region.owner.started/completed/failed`（generation/revision、HTTP status、安全なerrorCode、時間、supported）を追加した。BackendにはGET開始・owner検証・capability結果・失敗コードを追加し、sourceIdの桁数だけを補助metadataに記録する。token、資格情報、path、画像、raw response本文は記録しない。診断UIは実errorCode/HTTP statusを併記し、再接続成功stateで以前のエラーを解除する。

関連Backend 100件、Frontend 11ファイル310件成功。Hash128 owner、stale generation/public token、Region preflight、Whole-only fallback、C0/C1契約、C2-A配送、C2-B診断・URL/pair/staleを含む。実probeはCPUの小さな合成PNGとtools/listを対象とし、実RAW/GPUの画面受入とは区別する。C2-Cには進めない。

## 15. C2-B Windows受入PASSとC2-C自動Region（2026-10-25）

ユーザーのWindows実機報告により、基準 `1e3fa0307e6b128faa6f91aef9763b889d516c0c` のC2-BをPASSとする。owner取得・capability対応、中央／四隅／各edge、Whole/Region geometry一致、位置ずれなし、Zoom後の手動再要求、Before/After比較を確認済み。これはユーザー実機報告であり、agentがブラウザ操作した結果ではない。C2-Cの当時の実装・受入待ち状態は履歴として記録し、最終受入は§17を正本とする。

### 15.1 densityと暫定policy

`RawRegionAuto` は既存 `RawRegionDelivery` / `RawRegionOverlay` にview intentを渡す。独立Native worker、画像cache、保存ownerは追加しない。B1 Wholeの実採用frameのfullWidth/fullHeightをbitmap寸法とし、Native寸法・CSS scale・DPRからC0 `rawWholeDensity()` を呼ぶ。C0の既存rhoはrequired/bitmapなので、UIで指定された `rho = bitmap density / required density` へ逆数変換する。Whole densityはNative 1px当たりの最小軸bitmap pixel数、required densityはscale×DPRである。

以下はすべて **C2-C provisional** で、性能測定に基づく製品値ではない。Developer Diagnosticsにも表示する。

| 値 | C2-C provisional |
| --- | --- |
| Region開始 | rho < 0.85 |
| Region解除 | rho ≥ 0.95。中間は現在のON/OFFを維持 |
| Pan/Zoom集約 | B1と共用の非延長180ms timer、最新viewだけを保持 |
| wheel/button Zoom gesture終了 | 180msの静止。短いgestureは中間Draftを省略してFullへ集約できる |
| Region context / prefetch | 16 / 64 Full pixel |
| Region Fの要求 | Native長辺×min(1,scale×DPR)を256px単位で切上げ、Native長辺を上限とする |

Fの要求値はdensityからのintentであり、LCのaspect丸めをFrontendが再実装するものではない。Native preflightが返した実Fだけをplanner／表示へ渡す。予算は既存C1のside/pixel/PNG/MCP上限を維持する。capによる部分overlayは`limited`で診断表示し、残りはWholeで埋める。NativeがWholeより高い密度を供給できない場合は`no_density_gain`でRegionを表示しない。100%を超えてもNativeを超える情報量は主張しない。

### 15.2 RawViewと有限配送

`ImageViewer` は既存 `RawView` にpanX/panY/interactingを追加し、CSS viewport、DPR、scale、Native frame、geometryIdと同時に通知する。Native可視rectはC0 `visibleNativeRegion()` でclampする。PNG natural sizeやrequestedMaxSideから座標を逆算しない。Panのpointer capture開始／終了、wheel/button Zoomの静止でview gestureを通知する。JPEG描画分岐・ショートカットは維持する。

hookはB1と共用する180ms slotで途中viewを捨てる。待機中のviewは1個、Region配送のrunning descriptorは1個、pending finite planは最新1個。preflight結果から明示的に新render planを作る。新viewで送信済みNativeを強制preemptしない。最新planに置き換え、古い結果はviewGeneration/plan/request/owner/revision再検証で破棄する。Nativeは従来の共有workerで直列実行し、Wholeを優先する。通常のview変更ではHTTP Promiseを増殖させない。

Panでcacheのvalid域を出る、qualityや必要Fが変わる場合は集約待ちの間から旧overlayを外す。Wholeは保持する。同じowner/content/F/qualityのまま可視rectがcache valid域に完全包含される場合だけC0 `canReuseRegion()` と `rebindRegion()` を使い、latest viewへ明示rebindする。`adoptReuse()` は配送descriptorだけを更新し、`RawRegionOverlay.rebind()` は既存URL・decoded bitmap・保持Whole参照を再利用する。Native要求もdecodeもURL作成も発生しない。手動診断から自動へ戻す際には配送のviewGeneration下限を引き継ぐ。

### 15.3 Whole／Draft／Full／比較

高密度RegionはWholeと異なるFを必要とする。自動modeに限り、overlay contextが確認済みRegion preflight Fを明示する。WholeとRegionは同じdocument owner/revision/Native geometry/qualityで、Regionはその確認済みFと一致することを要求する。手動C2-B modeの同F検査は維持する。Before/After Region同士には引き続き同じF/W/validRegion/quality/bitmap寸法/view/planを要求する。

Pan/Zoom gestureと既存RawControlsのedit gestureは、同じhookのWhole表示intentのqualityへ合流する。操作中はACK revisionのWhole DraftをbaseにRegion Draft、終了後は最新view/revisionのWhole FullとRegion Fullへ収束する。mutation中の採用は禁止する。Before Wholeも同quality/revisionが必要で、未準備又は片側Regionのみの間はWholeを表示する。既存P1の非延長1000ms courtesyにRegion running/pendingも含めるが、gestureやHistory/save queueは追加しない。保存成功はRegion render/decode完了を待たない。

| 状態 | 所有・更新・不変条件 |
| --- | --- |
| 最新RawView / gesture | ImageViewer → hookの1 slot。pan、scale、DPR、Native geometryを同じviewで扱う |
| 自動Region intent / hysteresis / confirmed F | RawRegionAuto。owner/quality/Whole F/必要F/比較が変われば再preflight。FはNativeの結果だけ |
| descriptor / preflight / running / pending | 既存RawRegionDelivery。C0検証・最新view guardを維持、rebindにNative workなし |
| bitmap / URL / Whole base | 既存RawRegionOverlay / RawPreviewUrls。共有参照、pair一括採用、stale decode破棄を維持 |

photo/Filmstrip切替、Gallery、generation/token/revision変更、regeneration、mutation、save departure、Before終了、unmount/pagehide/shutdownでは既存の失効・解放経路を通す。自動plannerのF/intent/接続試行状態もresetする。density不足時に初めてRegion ownerを明示接続し、非対応・照会失敗ではWhole B1を継続する。失敗時にviewごとの無制限retryは行わない。

### 15.4 diagnosticsと画質比較

`/developer` のRAW Region Previewに自動Region ON／Region一時OFF（Whole-only）を追加した。Zoom/Pan位置は変更せずoverlayだけを切り替える。手動位置button又はRegion解除は自動modeを一時停止する。診断tabを閉じると通常の自動modeへ戻る。自動Before pairは暗室の既存Before/After操作に追従し、診断UI内のBefore checkboxは従来の手動位置試験用である。

診断表示はWhole bitmap/F、Region bitmap/F、DPR/scale、Native visible rect、Whole/required/Region density、rho、active/inactive理由、reuse/replan、Draft/Full、viewGeneration、budget limitedを示す。`region.auto.evaluate` は集約された判断を記録し、Pan event全件は記録しない。既存`region.started/delivery/received/overlay.*`とBackendのNative timingを併用し、queue wait・render/transport・decodeMs・adoptWaitMs・stale/superseded/cancelledを追跡する。token、画像、path、Recipe/History本文はログへ出さない。

### 15.5 自動試験と限定監査

関連Frontend 18ファイル451件成功後、save departureが送信中Regionを待たずに完了する追加試験を含むhook 74件と、失敗時retry loop抑止／generation別接続epochを含むauto 11件も成功（重複を除く合計454件）。最終の接続epoch修正は直接関連4ファイル107件で再確認した。C0/C1/C2-A Backend契約・配送35件成功。density/hysteresis、Native座標、独立高F、reuseでNative/decode/URL作成なし、F変更、100 Panのrunning1/latest pending1、Draft/Full、Before pair、stale view、capability fallback、owner失敗、manual→auto generation、Whole-only比較、lifecycle、P1、RAW/JPEG Viewer、History/save/Undo/Redoを対象とした。実ブラウザ操作・実RAWの画質／速度／メモリ受入とは区別する。

監査は無制限request、stale、quality/pair混在、Whole消失、capability fallback、境界振動、URL参照、保存待機、C3先行、JPEG影響に限定する。C3の製品値を確定せず、Windows C2-C受入を次の手順で行う。

限定監査ではmanual→autoのviewGeneration下限引継ぎ、no-density-gain抑止、失敗理由保持／retry loop抑止、decode待ち中の診断状態、旧generationのcapability照会が新接続を上書きしないepoch／promise所有を確認・修正した。未解決High/Mediumは0。TypeScript／production build／`git diff --check`成功。Windows hostのCargo dev build（locked/offline）成功。既存の500 kB超chunk警告とincremental cacheのhard-link→copy警告は継続。実画面、実RAW/GPU、長時間RSS/VRAM、NAS/Firefox、全suite、Docker release Smoke Testはこの実装時点では実施していない。

### 15.6 Windows起動・受入

Frontend production buildとWindows開発hostを用意した後、既存アプリを保存・終了し、PowerShellで次を実行する。canonical geometry修正版を別targetで使う（§16）。既存C1／診断用binaryは保持する。

```powershell
Set-Location I:\code\genzoroom
$env:GENZOROOM_LIGHTCRAFT_EXE = 'I:\code\genzoroom\.tmp\lightcraft-c2c-geometry-fix\target\release\lightcraft-cli.exe'
& '.\desktop\target\debug\genzoroom-desktop.exe'
```

1. 約4000px級RAWの細かい文字、建物の細線、植栽、テクスチャを暗室で開く。FitでWhole密度が十分ならWhole-onlyとなる。高DPR／大viewportでFitでも不足する場合は診断rhoに従ってRegionが必要になり得る。
2. Developer Diagnostics → RAW Region Previewを開き「自動Region ON」を選ぶ。暗室で100%以上へZoomし、Wholeを消さずRegionへ進み、Region F/densityがWholeより高いことを数値で確認する。Region bitmapサイズだけで高解像度化を判断しない。
3. Panを続け、必要時だけ更新され、白抜け・旧位置Region残留・位置ずれがないことを確認する。valid域内ではreuse、外ではreplanになる。pointerを離す／Zoomが静止した後、Fullへ収束する。
4. 同じZoom/Pan位置のまま「Region一時OFF（Whole-only）」と「自動Region ON」を交互に押し、細部を比較する。密度が上がっても画像内容によって画質差が目立たない場合がある。Dehaze境界はfeatherで隠していない。
5. 暗室の既存Before/Afterを切り替え、同じ位置・F・qualityの両側Regionが揃うまでWhole、揃ってからpairになることを確認する。
6. Zoom outでrhoが解除側へ達するとoverlayだけ外れWholeへ戻ること、photo切替／Gallery復帰で旧Regionが残らないことを確認する。診断のWhole-only一時停止はtabを閉じると解除される。

### 15.7 C3へ残すもの

最終rho threshold/hysteresis、context/prefetch、aggregation/quiet interval/F刻み、Region memory budget、latency・RSS/VRAM、Dehaze差の最終品質判定、長時間stress、Region部分coverage/tile戦略、RAW Export、Scope、NR/sharpening等の現像品質改善は未確定・C3対象である。C2の完了をもってこれらを確定した扱いにはしない。

## 16. C2-C canonical Native geometry root fix（2026-10-25）

実RAW・Recipe revision 120の調査で、Whole Preview source 2560×1925とRegion Full source 4064×3056のdescriptor差は`sourceAspect`だけだった。[調査履歴と修正結果](REGION_GEOMETRY_DESCRIPTOR_INVESTIGATION.md)に旧結果を残す。

geometry descriptorの内部contractを**2**にし、sampling bitmap比率をcanonical identityから分離した。`nativeAspect`の正本は`Frame::native_size_at(original)`の**orientation/crop適用後・整数丸め前**のNative幅÷高さ。同じsource content、original、resolved crop/orientation/flip/coordinate-moving warpならsampling source level・output F・qualityで変わらない。sampling aspectは`frame.src_w/frame.src_h`、実output aspectは`frame.aspect()`として調査diagnosticsに残る。公開frameの`aspect`や画像生成・座標変換は変更しない。

descriptorはsource identity、original、orientation、crop、flip、perspective/distortion/CA/lens/lensDistを保持し、gain-only vignettingを除く既存方針を維持する。resolved warpやcropが実際に変化すれば異なるIDになる。contract 1との互換aliasはない。Whole/Before/Region/StageCacheは同じ`frame_metadata()`を使う。公開Preview、Region request/response、Before contractは全て**1のまま**。

geometryIdはresponse/sessionのframe、表示owner、public/native mapping、StageCache、Region reuse/currentness、およびログexportで使う。Recipe/History、SQLite、XMP、Export/Immich metadata、saved sessionへidentityを保存する経路は見つからず、migrationは不要。mappingはdocument/generationで破棄され、各Native processは単一生成関数からcontract 2だけを生成する。`region.capability`ログは実tools/listの`geometryDescriptorContract:2`を記録する。

StageCacheのgeometry invalidationは実座標変更を扱う。sampling source安全性は別のsource/signature、CPU/GPUのsource Arc ownership、実Plan/size keysで守る。canonical ID一致だけで異なるsource pixelsを再利用しない。source切替cache pixel試験と実RAW cache ON/OFF比較で同一Full PNGを確認した。実RAWの512 MiB試験ではWholeはcache適用、Regionは既存budget判定で非適用となり描画を継続した。製品budgetは変更していない。

正式Native regressionに比例／丸めPreview fixture、全source level、Whole 1024/1472/2048、Draft/Full、Before/After、true geometry変更、tone-only変更、旧version不一致を追加した。C0のcenter・四隅・4 edge・任意rectのNative→Whole／F/window→Native roundtripも確認した。誤差上限はNative長辺4064における32 ULP（約1.46e-11 Native px）。6段程度のaffine演算の浮動小数丸めを評価するもので、samplingずれを許容する大きなepsilonではない。

公開の対象試験はFrontend **356**、Backend **190**、Native unit **70**＋E2E **10**成功、既存helper **1 ignored**。private実RAW harnessはCPU/DX12各2 tests成功。新binaryで同一RAW・同一RecipeのWhole 1024→1472→2048→Region plan 4064→**production C0 planner**→Region renderをCPU/DX12双方で成功し、echo・geometry・実F・W/validRegion・PNG実寸を既存Backend validatorで確認した。実F4064×3056、window1280×1536、validRegion1248×1504。C1有限budgetにより部分coverage（limited=true）となりWhole baseを維持する既存設計のまま。DX12はWhole/Regionともgpu_success。[安全化regression証跡](REGION_GEOMETRY_CANONICAL_REGRESSION.json)参照。

新EXE：`I:\code\genzoroom\.tmp\lightcraft-c2c-geometry-fix\target\release\lightcraft-cli.exe`。upstream `a2a41383c4fd62fa85a46ccd00998639221f2d3c`、managed patch SHA-256 `6d2e4113001aa8d9661ac706857191b2286ca420e4987be987bf55b6462609dc`、binary SHA-256 `7f4f76fd5c8989bf8439206c3bba778a753cf5e5b56359fb495cc14c4e914111`。隣接receiptはBefore/Preview/Region各1とgeometryDescriptorContract 2を持ち、発行前に実binaryの全C1 CPU/DX12 probeを完了した。旧2 EXE/receiptは上書きしていない。

TypeScript/production build、差分検査、private出力監査を成功し、限定監査の未解決High/Mediumは0。既存chunk/font警告とNodeのtest-only type strippingのExperimentalWarningあり。この時点ではWindowsのoverlay位置・細部・Before比較は未確認だった。以後のWindows実機受入で確認された結果は§17に記録する。

## 17. C2 Windows実機受入完了（2026-10-25）

ユーザーのWindows実機受入報告により、**C2-B PASS、C2-C PASS、C2全体をWindows実機受入PASSとして完了**とする。C2-BではRegion owner/capability、手動中央・四隅・四辺、Whole/Region geometry一致、位置ずれなし、Zoom後の旧Region失効と手動再要求、Before/After Region比較、Whole base維持、失敗時fallbackを確認した。

C2-C FitではWhole-only、Whole F 1472×1107、rho約1.01、`whole_sufficient`となり、不要なRegion表示はなかった。1:1ではWhole 2048×1540、Whole density 0.5039に対してrequired density 1となり、desired densityを満たすFull RAW Region（bitmap 1280×1536、実F 4064×3056、Region density 1）を`replan / budget limited`で表示した。Whole-onlyとの画質比較で細字・輪郭・細部の解像感が明確に向上した。Pan、Zoom、Zoom out/replan、Before/Afterでも白抜け、位置ずれ、古いoverlay残留はなかった。以上はユーザーの実画面報告であり、agentによるブラウザ操作ではない。

C2-C途中のgeometry原因は履歴として保持する。初期の1:1 Region planは`raw_region_geometry_mismatch`となった。public geometry mapping一致・Native plan到達・`desiredLongEdge=4064`・`geometry_id_mismatch`を診断し、同一実RAW/Recipe revision 120でWhole 2048 Preview 2560×1925とRegion 4064 Full 4064×3056を比較した結果、旧descriptorの`sourceAspect`だけが整数sampling寸法の丸めで異なり、Native座標geometry自体は同一と確定した。§16のCommit `01a6c86832749e7b18857a1d165ca58b663277e1`でdescriptor contract 2とcanonical `nativeAspect`へ修正済み。sampling aspectはidentityから分離し、source/original/crop/orientation/flip/座標移動warpを保持した。Before/Preview/Region公開contractは各1のまま。geometryIdは永続化されておらずmigration不要で、fail-closed mismatch検証も維持する。

根本修正後、同一RAW/Recipe revision 120でCPUとDX12双方のWhole 1024/1472/2048、Region plan 4064、production C0 planner、Region renderに成功した。Preview sourceとFull sourceでcanonical geometryId/Native寸法が一致し、Whole/Regionは実F・window・validRegion・bitmap寸法の契約を満たし、DX12は`gpu_success`だった。比例/丸めPreview fixture、geometry変更/tone-only回帰、Before、StageCache source所有、Native座標roundtripも確認済み。回帰証跡とbinary receiptは§16および[canonical regression記録](REGION_GEOMETRY_CANONICAL_REGRESSION.json)に保持する。

C2が満たしたのはWhole密度が十分なFitではWhole-only、高Zoomで不足する部分だけFull RAW RegionをWhole base上へ表示し、Pan/Zoom、Draft→Full、Before/After pair、stale/failure時のWhole fallbackを行う設計目的である。次は未確定のC3対象であり、C2完了とは分けて扱う：rho threshold/hysteresis最終値、context/prefetch最終値、aggregation/quiet interval、F刻み、Region memory budget、latency、RSS/VRAM、長時間stress、Dehaze品質差、部分coverage/tile戦略、RAW Export、Scope、NR/sharpening等の現像品質改善。実画面で観測したRAWのカラーノイズやPixel JPEGとの差も、C2 Region機構の不具合ではなく現像品質側の後続課題とする。**C3は未着手である。**
