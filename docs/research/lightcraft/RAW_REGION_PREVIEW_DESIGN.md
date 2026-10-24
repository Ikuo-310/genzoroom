# RAW Region Preview：工程C 実装前設計

2026-10-24（Asia/Tokyo）。基準GenzoRoom `79e198ede4750f52fbed9116d6351597f62755c3`、`feature/lightcraft-integration`。B1は[Windows受入記録](RAW_ADAPTIVE_PREVIEW_DESIGN.md#b1-windows-acceptance)により完了。本書は**未実装の推奨契約**であり、製品Regionコード・管理patch追加・工程C binary buildは行っていない。閾値や性能目標の候補を受入済み仕様と読まないこと。

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

各段階は受入条件を満たしてから次へ進む。今回の停止位置はC0実装の前。Region patch／binary作成は次回以降の明示依頼で行う。

Windows計画：B1と同じPixel 7 Pro 3990×3000クラスDNGを基準に、原寸Whole reference（試験専用、通常HTTPとは分離）との中心/四隅/境界比較、露光・NR・Dehaze、Fit→100%→100%超、斜め/高速/反転Pan、最大化/panel、DPR1/1.25/1.5/2とモニタ移動、Before/After連打を確認する。Whole baseが消えず、Regionが画像上に固定され、継ぎ目・位置ずれ・片側だけの高精細化がないこと。gesture Draft採用率・discard理由、最終ACK/History revisionとFull Region revision、終了→Whole Fullと→Region Fullを別測定する。CPU/DX12、cold/warm、budget拒否、写真切替/再生成/離脱、長時間Pan/編集、RSS/VRAM peakと解放後安定値を測る。実driver OOM/device lossは障害注入と分け、実施可否と未実施範囲を明記する。

自動試験は変更範囲に応じNative／Backend／Frontendの境界を選ぶ。shared schedulingと永続化連携を変えるC2では関連History/save/interaction試験を含める。全suiteが必要かはそのdiffのriskで判断する。ブラウザ動的操作・NASはユーザー担当、Docker全Smokeは通常工程C開発で実行しない。

## 10. 未決定事項と対象外

- rho閾値／hysteresis、Pan集約間隔、先読みmarginとcontextの最小安全量、最大2048/2Mで不足するviewportの扱いはC1/C3で決定。upstream4.5%は全設定の厳密な誤差上限証明ではない。
- effective Frameのsource level差・自動upright差がある場合の安定したF/geometry negotiationはC1で実Planのfixture検証が必要。小さいWholeのgeometryを無検証でFull sourceへ持ち込まない。
- 初期Cの異geometry Before比較は安全に拒否。native mapping拡張、複数tileによる全面精細化、別転送形式は後続判断。比較を常に可能にする要件なら実装前にこの範囲を再合意する。
- memory／timeout初期値は予算設計案。実device/host capacityとFrontend peakを測るまで速度・RSS/VRAM保証をしない。
- RAW Exportは出力品質・色空間・保存/Stack/COVER/Album契約を持つ別工程。Region PNGをExport入力や永続cacheにしない。Scopeは可視Regionの局所分布を全画像histogramに流用せず、Whole/別集計契約を維持する。Recipe/History/DB format、JPEG Viewer、Export Queue、NAS配備は今回変更しない。
