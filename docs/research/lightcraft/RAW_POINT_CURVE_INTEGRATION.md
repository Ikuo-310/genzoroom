# RAW Point Curve Integration Research

調査日: 2026-11-07  
対象: GenzoRoom `feature/lightcraft-integration`、Managed LightCraft v0.18.1、上流タグv0.18.1/v0.19.0

## 結論と調査範囲

LightCraft v0.18.1には4チャンネルのポイントカーブ、設定readback、Reset、画像上ターゲット調整が既にある。v0.18.1とv0.19.0のポイントカーブ契約は同一であり、P1〜P6の統合に新しいNative patchや独自現像処理は不要と判断する。これはソース契約の比較結果であり、v0.19.0への更新推奨ではない。GenzoRoomの途中実装には後述する未解決事項がある。

上流参照commitはv0.18.1 `57024f072c234e0c6c850e0940a261790f976575`、v0.19.0 `16636c45a63bff3065a6fd31aecc22a6fc15ca53`。主な参照元は`crates/develop/src/settings.rs`、`crates/engine/src/cmd/develop.rs`、`crates/engine/src/cmd/curves.rs`、`crates/engine/src/cmd/color.rs`、`crates/pipeline/src/finish.rs`、`crates/color/src/spline.rs`。

## Native契約

`DevelopSettings.curve`は`ToneCurve`。ポイントチャンネルは`master`、`red`、`green`、`blue`で、それぞれ`Vec<Point>`を持つ。点は`Point { x: f64, y: f64 }`、入出力とも0..1。配列が空ならidentityとして扱われる。ToneCurveにはこれ以外にパラメトリック値、split値、`refine_saturation`もあるため、ポイント編集でこれらを上書きしてはならない。

`develop.curve`は選択チャンネル全体を置換するコマンドで、引数は例えば`{"channel":"master","points":[[0,0],[0.5,0.6],[1,1]]}`。`master`省略時の既定値であり、`rgb`もmasterの別名。Nativeは座標を0..1にclampし、x順にsortするが、無効要素を黙って除外する。GenzoRoomは送信前に形式・有限値・範囲を検証する必要がある。Nativeコマンドに点数上限の検査はない。

`develop.get`のreadbackは同じ点を`{"curve":{"master":[{"x":0,"y":0},{"x":0.5,"y":0.6},{"x":1,"y":1}]}}`のオブジェクト配列で返す。コマンド要求のペア配列と混同しないこと。完全snapshotの復元には既存の`develop.merge`を使える。

`curve.reset`は`channel`に`master`/`red`/`green`/`blue`を指定して単一チャンネルを初期化する。`point`は4つすべて、`all`（既定）はToneCurve全体を初期化し、後者はparametric値と`refine_saturation`も含む。ポイントカーブ全体Resetには`point`を使う。

既存の`develop.targeted`は画像座標と上下移動量から曲線領域を変えるAPIで、曲線入力値は384px長辺proxy上の3×3サンプルから得る。ポイントカーブも指定channelで更新・追加できる。P1〜P6の対象外。

補間はNativeの`MonotoneCurve`（単調Hermite/Fritsch–Carlson）で、pipelineの`finish.rs::curve_luts()`がパラメトリック曲線、master、各色チャンネルをLUT合成する。CPU/GPUのPreviewおよびExportは同じNative設定・pipelineを通る。GenzoRoomで曲線演算を実装しない。上記契約の版比較から、ポイントカーブのためのNative patchは不要。

## GenzoRoom統合方針

既存のRAW Historyはbaselineと各stepに完全settings snapshotを保存し、Undo/Redo/Jumpでsnapshotを復元する。Recipeも完全設定を保持できるため、History基盤や永続データ形式は増やさない。ただし現在のHistory操作は数値control等の許可型に限られており、曲線配列を1操作として記録する構造化操作の拡張が必要。

制御点はHistory metadataではなく、Native readback後の完全settings snapshotに保持する。現在のHistory metadata上限は1KBで、点配列を格納する場所として不適切。metadataには操作種別とチャンネル程度を置く。Native成功後に`develop.get`で完全readbackし、そのsnapshotを既存History保存へ渡す。対象チャンネルだけの置換であり、他チャンネルとToneCurveの非公開設定が保持されたことを確認する。

旧Recipeに`curve`がない場合、LightCraft v0.18.1のserde default（空ポイント配列、既定parametric値、既定refine saturation）をエンジン比較・復元用表現へ補う。DB内Recipe、History snapshot、receiptは遡及書換えしない。Exportも`raw_export_artifact.py`のNative設定readback照合で同じ既定補完を適用する。

NativeではLightカテゴリを無効化するとCurveも無効になる。既存のこの連動を保ち、独立Curve ON/OFFは追加しない。All Resetは既存Native全体Resetを維持する。

## UIとドラッグ契約

React＋SVGで正方形グラフ、グリッド、identity対角線、制御点、選択チャンネルを描く。4チャンネル共通UIで、切替・点追加・選択・移動・内部点削除・単一チャンネルReset・全ポイントResetを提供する。空配列は表示上identityとして描き、表示のためだけにNative設定やHistoryを書き換えない。表示曲線は折れ線または簡易補間でよく、Native補間との厳密一致は求めない。

Pointer Downで開始配列・チャンネル・document ownerを固定する。Pointer Moveはローカル状態とSVGだけを更新し、Native要求を送らない。Pointer Upで最終位置を反映し、最終配列を一度だけ既存`operate()`へ渡す。変更なしはHistory 0件、1ドラッグは最大1件。Escape/pointercancelは開始配列へ戻しHistoryを作らない。確定要求はimmutableなbodyと既存saveId/receipt再送契約に従い、応答不明時に別stepを作らない。切替・離脱で二重確定しない。

ヒストグラム背景と写真上ターゲット調整は後段に保留する。独自Preview Native契約は追加しない。

## 途中差分で確認した未解決課題

現在の未コミット実装には以下の課題がある。本書では既知事項として記録し、今回の文書作業では修正しない。

1. History操作の検証順序が不適切で、カーブ操作が拒否される。
2. 制御点配列を1KB上限のHistory metadataへ格納している。
3. Native操作後、対象外チャンネル・非公開設定が保持されたことのreadback検証が不足している。
4. 不正なreadback制御点を黙って除外している。
5. Frontend応答検証、History表示、SVG UIが未実装。

## 実装Phase計画

以下は計画であり、P0以外は未着手・未完了として扱う。

| Phase | 目的・変更範囲 | 状態 |
|---|---|---|
| P0 | 調査結果の研究文書化 | 完了 |
| P1 | 設定型と入力/readback検証 | 完了 |
| P2 | Native操作と既存History接続 | 完了 |
| P3 | Reset・旧Recipe・Export互換 | P3-A〜P3-C完了 |
| P4 | SVGグラフUI | P4-A〜P4-C完了 |
| P5 | Viewer接続とドラッグ確定 | P5-A/B完了。ドラッグ中の写真Previewは本書§9の設計段階 |
| P6 | 統合検証と実Desktop受入 | 未完了 |

パラメトリックカーブは全Phaseで対象外。ヒストグラム背景と写真上ターゲット調整はP1〜P6の範囲に含めず、後段へ保留する。

## P3-C Export接続補足

既存Export Runtimeは保存Recipeを凍結して`RawExportInput.settings`へ渡す。`raw_export_artifact.py`はその設定を編集せずNativeの`develop.merge`へ送り、readback期待値を作る際に既存`with_legacy_curve_defaults()`を適用するため、`curve`がない旧Recipeも同じv0.18.1既定構造で照合される。4チャンネルを含むRecipeと空ポイント配列も同じ経路を通る。Recipeやreceiptの保存更新、専用Curve Export処理はない。

Export前後の`get_develop`完全設定比較は既存の境界検証であり、P3-Cでは強化・追加していない。これはピン留めされたNativeのreadbackが入力Recipeを通常どおり反映する契約を確認する既存動作で、LightCraft内部処理や画素出力の一致保証ではない。将来のNative正規化・追加設定でこの比較が失敗する可能性は実Managed Native binaryで別途確認が必要。今回のExport検証は既存fixtureによるもので、Managed Native、実RAWのJPEG生成、Immich実登録は未検証。

## 証拠の限界

P0のNative契約調査はLightCraft上流ソース比較とGenzoRoomローカルコード読解に基づく。P5-B.1もコード読解とv0.18.1ソース確認による設計調査であり、Native実binary probe、Preview/Export実行、性能測定、実Desktop操作は行っていない。以前に記録した未完成差分課題は解決済みを意味しない。

## P5-B.1 ライブPreview経路調査・設計（2026-11-07）

### 現行RAWスライダーとPreview経路

数値スライダーは`RawAdjustmentControls` → `useRawDocument.changeControls` → `RawControls.change/flush`を通る。`RawControls`は数値`RawValues`だけを一つのpending patchへ集約し、最初の未送信入力から150msのbounded timerで`setRawControls`を呼ぶ。Native readback後に`confirmed`を更新し、`options.preview`からPreviewを要求する。Pointer中は`beginPreview()`がinteracting状態を保持し、`displayPreview`は`draft`を選び、終端後にFullへ収束する。Curve配列は`RawValues`ではないため、数値APIに点配列を詰め替えることはできない。

Frontendの`useRawDocument.displayPreview`はdocument token、Native revision、quality、max side、view generationで要求を識別し、`displayPending`は最新一件、`displayRunning`は一件に制限する。`invalidateDisplay`はgenerationを進め、旧要求をcancelし、`renderPreview`はdecode後にもowner/revision/viewを照合してから表示する。Backendの`LightCraftRawSession.request_preview`もAfter用latest-wins pending ticketと単一workerを持ち、`_ticket_current`でgeneration/epoch/sequence/revisionを検査する。実行中Native renderの計算自体は停止できない場合があり、その結果は採用しない。document切替ではFrontend owner invalidationとBackend handle/generation/tokenで分離される。

Nativeの現像設定更新とPreview生成は別要求である。RAW経路では設定mutation成功後に`render_preview`を要求し、管理Native Preview契約の`quality: draft|full`、表示辺長、既存StageCache設定を用いる。Viewport/DPR/Zoomから得る`rawWholeSide`と`viewGeneration`は既存Preview plannerが管理し、ドラッグ中は操作ビューに応じたDraft、終了時はFullを選ぶ。Native image generationには既存設定が使われ、GenzoRoomでカーブ計算はしない。

現在のCurveドラッグは`RawPointCurveControls`がPointer Up時だけ`onDragCommit`を呼び、`RawAdjustmentControls`が既存`operate({kind:'curve'})`へ渡す。したがって、Pointer Move中にNative設定が変わらず、既存Preview要求も起きない。MoveごとにP5-Bの`operate()`を呼べばHistoryとRecipe確定が複数発生するため、そのまま流用できない。

### LightCraft v0.18.1の一時変更と公式Desktop

`develop.curve`は現在選択中Photoの`DevelopSettings`を変更するEngine commandで、settings変更後のrenderとは分離されている。`render_preview`は現在のdevelop settingsを使う別MCP toolであり、**settings overrideを受けるPreview APIではない**。従ってPreviewだけへカーブ設定を渡してNative状態を変えない経路は、確認したv0.18.1の公開APIにはない。

公式UIの`crates/ui-egui/src/panels/edit/curve.rs::curve_editor`はドラッグ開始時に`develop.beginInteraction`、点変更ごとに`develop.curve`を実行し、release時に`develop.endInteraction`を呼ぶ。`crates/engine/src/cmd/develop.rs`の`develop.beginInteraction`／`endInteraction`／`cancelInteraction`はEngine commandである。Engineの`Session::set_develop`はInteraction中に`apply_silent`を行い、`end_interaction`で元の値をsilently戻して最終値を一つのNative History stepとして設定し、`cancel_interaction`は開始時値へ戻す。公式UIは同一プロセス内のInteraction状態を見て、`crates/ui-egui/src/panels/detail.rs`の`drag_scale`で画像レンダリング精細度を操作中に調整する。点グラフ以外にカーブ専用現像計算はない。

Managed MCPは一般`command_run`と`render_preview` toolを提供するため、既存公開commandの組合せでこの方式へ接続できる。`render_preview`には既にDraft/Full品質があり、カーブ専用Native Preview APIや新しい補間APIは不要。GenzoRoomはLightCraft DesktopのTexture更新を購読する同一processではなく、HTTP/MCP経由で画像を受け取るため、公式UIの自動再描画を直接使わず、既存のRAW PNG Preview経路へ接続する。

**Native patchは不要**と判断する。これはManaged v0.18.1に存在する`develop.curve`、interaction commands、`render_preview`の組合せに基づく静的調査であり、今回実binary probeやDesktop動作確認を行ったという意味ではない。

### 比較案

| 案 | 必要変更 | 応答性 | Native/History/Export一貫性 | 評価 |
|---|---|---|---|---|
| A. 既存Preview経路のみ再利用 | `displayPreview`/既存Preview queueへ要求 | 最新一件化、stale破棄、DPR/Zoom/adaptive品質は再利用可能 | Native設定が更新されないので写真は変化しない。P5-Bの`operate()`はHistory保存も起こす | 描画queueだけでは不可。設定を一時変更するBの下位経路として使う |
| B. 一時Native設定更新＋既存Preview | BackendにCurve Interaction ownerと一時更新/取消/確定状態を追加。Frontendは既存Preview queueを利用 | Native更新後にDraftを要求。UI操作中はSVGを止めず、Native設定ACKごとに最新Previewだけを求める | Native設定は一時状態、Genzo History/Recipe snapshotはPointer Upまでbaselineを維持。CancelでNative originalへ戻し、Upで一度だけ確定 | **推奨**。既存scheduler/Preview/History契約を保ちながら、Preview用の現像処理を作らない |
| C. 公式Desktopの経路をそのまま移植 | `beginInteraction` → `develop.curve`繰返し → `endInteraction`/`cancelInteraction` | Native Interaction中の設定を各renderへ反映する公式方式 | Native自身は一つのinteraction stepに集約するが、Genzoは別の完全snapshot Historyを持つ。既存P2 `operate()`を単純に最後に呼ぶと同じCurve commandを再適用し、Native側で二重編集/Historyになる | **BのNative側機構として採用**。UIの内部texture/render schedulerは移植せず、既存MCP Previewを使う |

### 推奨設計

案BとCのNative Interaction semanticsを組み合わせる。ドラッグ中はUIに点配列のローカル最新版を即時描画し、Preview用Native更新は別のbounded schedulerへ渡す。Nativeは`develop.beginInteraction`の後に最新の`develop.curve`だけを適用し、既存`render_preview`でDraftを作る。History/Recipeはこの期間書き換えない。既存`RawControls`の150ms non-extending timer、一つのin-flight＋一つのlatest pending、`displayPending` latest-wins、`RAW_DISPLAY_COURTESY_MS`の制御思想は再利用候補だが、`RawValues`型や`setRawControls`をカーブ配列へ流用しない。

ドラッグ間隔は固定確定しない。150msは現在のRAW数値操作が使う初期候補で、理論上およそ6.7更新/秒を上限とする。カーブ更新のEngine command/readback、Preview Native render、PNG転送、decodeの実測はまだない。既存`RAW_PREVIEW_INTERACTION_PERFORMANCE.md`のScheduler/模擬遅延結果は、実Curve・実DNGの追従速度や60fps保証ではない。まず既存debugのinput/ACK/`preview.measured`/`preview.received`/`preview.decoded`/`preview.completed`/discard理由をgesture単位で集計し、RAW実機でPreview採用率と画像ageを確認してから値を調整する。

確定と取消は既存document owner/History fenceで直列化する。

1. Pointer Downで`documentToken`、generation、channel、baseline settings、Native interaction idを固定して、`RawRecipeSave`のHistory/Recipe操作をgesture中lockする。
2. Pointer MoveはSVGのみ同期更新。スケジューラは点配列の最新値一件だけを保持し、Native更新は一件ずつ実行する。Preview要求も既存queueの一running＋一pending以下とし、遅れたNative設定や画像を新しい点位置の結果として表示しない。
3. Previewの有効性には既存asset/document/generation/view checksに加え、Curve interaction idとmonotonic preview sequenceを含める。動作中要求はbest-effort cancelし、sequence/generation不一致の応答はdecode後も採用しない。
4. Pointer Upでは最新の配列をdrainし、Native interactionを`endInteraction`で閉じる。P2の`operate(curve)`は確定snapshotをHistoryへ保存する入口として再利用するが、Backendは更新済みNative curveをもう一度`develop.curve`で適用してはならない。History snapshot/readback保存と既存saveId/receiptはこのfinalizeに結び付け、同じsaveIdのRetryが二重Native Interaction/History stepを作らないようにする。確定後は既存Preview経路で最終Fullを要求する。
5. Pointer Cancel/Escapeでは未送信latestを破棄し、進行中Native更新とPreview ownerをsettle/cancelした後に`cancelInteraction`し、baseline settingsをreadbackして写真とグラフを復元する。History/Recipeは書かない。Preview失敗はHistory結果と切り離し、Native mutationが不明なら既存recovery/reset policyでbaselineへ戻す。

temporary settingsを`photo.settings_json`/`RawRecipeSave.confirmed`の確定snapshotとして誤採用しない境界が重要。現行`LightCraftRawSession._preview_readback`はNative `develop.get`が`photo.settings_json`と異なると、現在settingsとして`_commit`してticketをrevision supersededにする。さらに`request_preview`/`_ticket_current`は`applied_revision == requested_revision`を要求する。このままNativeを一時変更すると、Preview readbackが一時値を通常readbackとして採用し、History/Recipe ownerの確定設定と分離できない。Backendにはbaselineと一時working settingsを識別し、Preview ticketをdurable revisionではなくinteraction id/sequenceへ結び付けるadapterが必要。保存・Undo/Redo/Jump・document切替・Exportはgestureをfinalize/cancelするまでlockまたは安全なfenceで待たせる。Exportは保存済みRecipeを使い、一時working settingsを入力にしない。

Preview workerとNative mutationは同じLightCraft session/selectionを使う。既存BackendがPreview処理中にNative lockを保持するため、各Pointer eventごとのMCP requestをFIFOで溜めない。Native updateのin-flight一件＋latest pending一件、Previewの既存一running＋latest pendingを保ち、Pointer Up/Cancelは最後の値またはcancelを先行待機へ差し込む。document切替時はownerを無効化し、古い操作が新document/active photoを触れないようにする。

Native command update数はsessionの既存mutation-attempt/regeneration thresholdにも影響する。現在の`RawControls`の通常更新ですらmutationごとのattemptを数えるため、長いcurve dragで未計測のまま全Pointer eventをNativeへ流す設計は採らない。bounded cadenceに加え、gesture duration/update上限、上限到達時のcancel/recovery方針を実装前に定める。これは画素結果検証やNative algorithm再実装ではなく、GenzoRoomのsession所有/上限保証である。

### 主な変更候補と最小Phase案

| Phase | 変更候補 | 目的・完了条件 |
|---|---|---|
| L1. Native一時Interaction owner | `backend/lightcraft_raw.py` (`LightCraftRawSession`, `_mutate`, `request_preview`, `_preview_readback`, `_ticket_current`)、必要な`backend/windows_raw_api.py` endpoints | Begin/update/cancel/finalize ownership、baseline/working separation、bounded latest-wins、Native interaction cleanup/recovery。Recipe/History/receiptはPointer Moveで変わらない |
| L2. Frontend Preview接続 | `frontend/src/rawApi.ts`、`useRawDocument.ts` (`displayPreview`, `pumpDisplay`, invalidation/owner)、`RawControls` preview-interaction flag、`RawAdjustmentControls.tsx`、`RawPointCurveControls.tsx` | SVG即時、Draft Preview採用、sequence stale discard、document/channel switch cleanup。Moveでは`raw.operate()`しない |
| L3. Finalize/CancelをHistory fenceへ接続 | `frontend/src/rawRecipeSave.ts`、`backend/windows_raw_api.py`、`backend/lightcraft_raw.py`、既存`backend/raw_recipe_store.py`保存境界 | Upは最新readbackをexisting curve operation/saveIdでHistory一件、duplicate Native curve applyなし。CancelはHistoryなしでbaselineに戻す。Undo/Redo/Jump/Retry整合 |
| L4. 限定検証・実測 | Frontend/Backend関連Preview・History tests、Managed v0.18.1 DNG probe、実Desktop | 連続入力/遅いMutation/遅いRender、latest-only/stale-result、cancel/failure/switch、export隔離を確認。実機のPreview採用率・age・end-to-end latencyからcadenceを確定 |

`raw_recipe_store.py`に新schema/履歴基盤を足す前提は置かない。既存完全snapshot・saveId/receiptがfinalizeを保存できるかを先に使い、必要な修正があればその境界だけに限定する。Native patchは現時点で不要だが、v0.18.1の`beginInteraction`/`endInteraction`/`cancelInteraction`とManaged binary `render_preview` contractが意図どおり動くprobeは実装受入前に行う。

### 未確認事項・リスク

- 今回はNative実binary、Preview性能、Preview cancel完了時間、RAW exportとの実機競合を試していない。コード読解に基づく設計であり、操作速度を受入済みとは扱わない。
- Native sessionの`Session::begin_interaction`は既存Interactionがあると先に終端する。GenzoRoom側で写真切替・別操作を同じNative sessionへ入れないowner lockが必須。
- `develop.beginInteraction`/`endInteraction`/`cancelInteraction`のtransport結果不明時、Native Interactionが開いたままかどうかを推測しない。receiptの再送またはsession reset/reopenで確定させる。
- `_preview_readback`の一時状態扱い、Native/Preview共通lockのwait、Native attempt threshold、Preview Full/Draft source/StageCache時間の組合せは、L1/L4 probeで実測する。
- P5-CのReset、右クリック削除はこの設計調査に含めず、今回実装もしていない。パラメトリックカーブ、ヒストグラム、写真上ターゲット調整も引き続き対象外。
