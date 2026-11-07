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

P0のNative契約調査とP5-B.1のライブPreview設計は、その時点では上流ソース比較とGenzoRoomコード読解に基づく。L0では以下の範囲でmanaged v0.18.1 binaryのInteraction/Preview probeを実施した。実DNG、実Desktop操作、GenzoRoom Backendを通した競合・性能測定は未実施。以前に記録した未完成差分課題は解決済みを意味しない。

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

## P5-B.1 L0 Managed Native Interaction実動作Probe・Backend境界監査（2026-11-07）

### 実Native Probe

Repository内のmanaged binary `.tmp/lightcraft-0.18.1/target-lens-profile-info/release/lightcraft-cli.exe`を起動し、MCP `initialize`の応答version `0.18.1`を確認した。binary SHA-256は`1A2006FE083EEB15FF7DC7D054183CF5405C68CDCA66C7A7BDC154D745871A3C`。テスト入力は`native/lightcraft/settings_export_probe.py::synthetic_dng()`が生成する128×96の無圧縮Bayer DNGで、一回限りのtemporary directoryに置いた。ユーザー写真、Immich、Recipe DBにはアクセスしていない。Probeは既存MCP toolを通し、Native sourceからの推定ではなく実行結果を記録した。

使用した引数と応答は以下。MCP `command_run`は全て`"ok"`を返し、最後のprobeではNativeエラーはなかった。

| 段階 | 実際のtool引数 | 結果 |
|---|---|---|
| 初期readback | `get_develop {"id":1}` | 初期`curve`は`master`/`red`/`green`/`blue`全て空。parametric値は`shadows=0`, `darks=0`, `lights=0`, `highlights=0`、split値は`25/50/75`、`refine_saturation=100`。 |
| Native History baseline | `command_run {"id":"history.clear","params":{}}`の後、`command_run {"id":"history.list","params":{"id":1}}` | `ok`。`history=["Cleared History"]`, `cursor=0`, `versions=[]`。 |
| 開始 | `command_run {"id":"develop.beginInteraction","params":{"label":"GenzoRoom curve probe cancel"}}` | `ok` |
| 1回目の一時変更 | `command_run {"id":"develop.curve","params":{"channel":"master","points":[[0,0],[0.45,0.62],[1,1]]}}` | `ok`。続く`get_develop`は`curve.master=[{x:0,y:0},{x:0.45,y:0.62},{x:1,y:1}]`を返した。 |
| 2回目の一時変更 | `command_run {"id":"develop.curve","params":{"channel":"master","points":[[0,0],[0.45,0.70],[0.72,0.82],[1,1]]}}` | `ok`。続く`get_develop`は最終4点を返し、`red`/`green`/`blue`は空、parametric値・split値・`refine_saturation`は初期readback値のまま。 |
| Interaction中の画像 | `render_preview {"id":1,"max_side":128,"quality":"draft","preview_contract":1}` | 128×96 PNGが生成された。baseline PNG SHA-256 `0ca6a981e2d6c89301fcdd0874036d2a233b27ae2078db4cf8164cdf82ce0276`に対し、変更中は`bc629e6eb81a200b53fc9d5cc2d0154ef6990165de0bd2c3f7d0b04d52bad906`となり、画像bytesも6469から2979に変化。直後の`get_develop`はカーブ設定を維持した。Preview readbackで設定は変更されなかった。 |
| Cancel | `command_run {"id":"develop.cancelInteraction","params":{}}` | `ok`。完全`develop.get`は開始時snapshotと一致し、Preview PNG SHA-256もbaselineと一致。 |
| End側Interaction | `command_run {"id":"develop.beginInteraction","params":{"label":"GenzoRoom curve probe end"}}` → 上記2つの`develop.curve` → `command_run {"id":"develop.endInteraction","params":{}}` | 全て`ok`。1回目の変更後のInteraction中`history.list`はbaselineのまま。終了後readbackは2回目の最終配列を保持し、Native `history.list`は`["Cleared History","GenzoRoom curve probe end"]`, cursor `1`となり、最終的に1件だけ追加。 |
| Native Undo/Redo | `command_run`で`history.previous`、`history.next` | 両方`ok`。Undo後は開始時カーブ、Redo後は終了後カーブにreadbackが戻った。 |

fresh importのNative Historyは空で、初回probeでは`history.previous`が「at the first History step」と拒否された。これはInteraction失敗ではなくUndo可能なbaselineがないprobe fixture状態による。最終probeでは`history.clear`を一度実行して`["Cleared History"]`, cursor `0`のbaselineを作ってから取消・終了・Undo/Redoを確認した。`history.clear`は一時fixture内だけに作用した。

実測ではNative Interaction中に1回目のカーブ変更をreadbackしてもHistoryは増えず、続く複数変更後のEndで最終的に1 stepだけが追加された。Cancelは完全に戻り、`render_preview`は変更中のNative設定を使う。従って、v0.18.1ではP5-B.1の「一時Native設定＋既存Draft Preview」案が実動作することを確認した。GenzoRoom側のAPI／History DBとの結合、競合時の動作、実RAWでの追従性能はこのprobeでは検証していない。

### Backend同期・検証の責任分類

参照した実装は`backend/lightcraft_raw.py`の`_photo`、`_commit`、`get_settings`、`_restore`、`_mutate`、`request_preview`、`_ticket_current`、`_preview_readback`、`apply_history_operation`、`backend/windows_raw_api.py`の`_confirmed`／`_history`、`backend/raw_recipe_store.py::_save_history`。

| 分類 | 箇所・既存目的 | 監査結果 |
|---|---|---|
| A — GenzoRoom保証として維持 | `_photo(active=True)`のhandle/generation/document owner検査、`_ticket_current`のepoch/sequence、Previewのlatest-wins、document切替時のinvalid化 | 古いAsset/Documentや古い画像が現在の写真として採用されるのを防ぐ所有権境界。Interaction中も維持し、Interaction idとsequenceを追加で照合する。 |
| A — GenzoRoom保証として維持 | `_mutate`のexpected revision確認、`requested_revision`予約、操作の直列化、Native結果不明時のdesynchronized/recovery、`MAX_EDITS`等の上限 | 確定操作の競合、二重適用、無制限Native呼出しを制御する。確定操作には残す。一方、Moveごとに`_mutate`を呼ぶとrevision予約・Preview invalidation・edit count・mutation Historyを消費するので使わない。interaction update数にも上限を設け、終了/Cancel/recovery用の余力を残す。 |
| A — GenzoRoom保証として維持 | `windows_raw_api._history`と`raw_recipe_store._save_history`のrevision CAS、完全snapshot、saveId/request fingerprint/receipt、単一transaction | Native readbackを保存することと保存の冪等性を担う。receiptはDB書込Retryの二重Historyを防ぐが、それ単独ではNative commandを一度だけ実行した保証にはならない。Finalize状態も既存pending save段階に保持する。 |
| A/D — 用途を限定して維持 | `_restore`の`develop.reset`＋`develop.merge`後に完全readbackを要求する処理 | Recipe/Historyの選択済み完全snapshotを復元できたかを確かめるGenzoRoomの永続化保証なので、Preview都合で撤廃しない。比較対象は保存snapshot全体であり、固定フィールド一覧ではない。将来Nativeが正規化を変えた時の比較意味はAPI互換probeで評価する。 |
| B — 通常Previewには必要、一時Interactionには不適 | `request_preview`と`_ticket_current`の`applied_revision == requested_revision == ticket.revision` | 確定mutation中のAfter画像を古いrevisionで返さない通常PreviewのFence。Interaction中のworking settingsは意図的にbaseline revisionと異なるため、その状態を不整合として拒否するのは誤り。durable revisionとinteraction sequenceを分離したticket経路が必要。 |
| B/C — 一時状態の確定取り込みには不適 | `_preview_readback`はPreview後の`develop.get`が`photo.settings_json`と異なると`_commit`してrevisionを進める。`get_settings`も差異を読むと`_invalidate`＋`_commit`する。`windows_raw_api._confirmed`はsnapshotをAPI documentのrevision/fingerprintとして更新する。 | `_commit`自体はRecipe DBへの書込みではなく、RAW sessionのin-memory `settings_json`/revision更新。Recipeは別の`put_raw_recipe`または`_history`→store transactionで保存する。通常のHistory `readback`段階はrevision/fingerprint差をconflictとして返し保存しない。ただしPreview readbackがInteraction中のworking stateを`_commit`するとGenzoのdurable ownerと一時状態が混ざり、後続APIのrevision fenceを壊す。Interaction ticketのreadbackはworking snapshotとしてのみ返し、`_commit`/`_confirmed`/Recipe保存へ流さない。 |
| C — 過剰な操作後検証 | `apply_history_operation`の`curve`／`curveReset`は、Native `develop.get`全体が事前snapshotへ操作差分だけを適用した`expected`と完全一致することを`check(actual)`で要求。 | v0.18.1の公開`develop.curve`契約は対象channelの点配列を設定する。実probeでは要求が`ok`となり、readbackとPreviewに適用された。全Native設定の不変性をGenzoが毎回再証明する必要はなく、他設定の将来正規化や新フィールドを理由に失敗し得る。今後の関連修正ではrequest/readback shapeと成功を検証し、返った完全Native snapshotを保存する。Native内部の副作用検証を追加しない。 |
| D — 実故障条件を見て判断 | `_preview_readback`を通常Previewで行う追加`develop.get`と、差異時のrevision更新 | v0.18.1 probeでは`render_preview`前後のworking readbackは一致し、Previewは設定を変えなかった。したがって正常なrender結果の確定にこのreadbackは不要。現行実装がPreview helperの部分失敗後に学習済み設定defaultを同期する場合も想定しているため、一括削除の根拠はまだない。L1ではInteraction中だけ別扱いにし、通常経路を外す場合はhelperによるNative設定変更という具体的故障を再現・確認してから判断する。 |
| D — 上限の数え方は未確定 | `_mutate`の`_edits`はNative mutation試行を数え、rollbackにも数を加える。Interaction中の各`develop.curve`をここへ入れるとドラッグが多数の確定mutationとして消費される。 | セッション上限は撤廃しない。Interactionのbegin/update/end/cancelをどの既存上限単位へ算入するか、許可更新数とgesture寿命、上限到達時に終端できる予備枠をManaged runtimeで測ってL1前に決める。 |

**Native readbackが異なるだけでRecipeへ自動保存される設計ではない。** `_commit`と`_confirmed`が更新するのは現在のRAW session/API document snapshotとそのrevision/fingerprintである。Recipe/Historyの永続化は専用のsave/history経路を通る。通常履歴operationの未適用readback差はrevision conflictとなり、DBへ書かれない。ただし、Interaction中のworking readbackを既存`get_settings`または`_preview_readback`に通せばin-memoryの確定snapshotへ昇格するため、その経路を一時操作で共有しない必要がある。

### L1の最小変更方針

1. `LightCraftRawSession`に**単一のactive curve interaction owner**を保持する。ownerは既存`RawHandle`、generation/document token、開始`applied_revision`、channel、baseline Native settings、monotonic interaction sequence、状態（open/finalizing/canceling/saved）を持つ。別photo選択・mutation・Export開始は同じNative sessionで交錯させない。v0.18.1の`Session::begin_interaction`はすでにInteractionがあれば暗黙に先に終了するため、このowner fenceは必須。
2. durable `photo.settings_json`、`applied_revision`、`requested_revision`、Frontend recipe fingerprintは開始値のまま保持する。Native `develop.get`/Preview結果はownerとsequenceに対応する一時working stateとして扱い、`_commit`や`_confirmed`へ通さない。Preview ticketは保存revisionとは別のinteraction id/sequenceを持つが、既存handle/document/generation/view ownerとlatest-wins/cancel判定はそのまま使う。
3. Previewのreadbackは、Interaction中ならNative working settingsの応答shapeとPreview ownerだけを確認し、その値をdurable revisionやHistoryへ採用しない。通常Previewの`_preview_readback`完全比較・revision bumpは別途必要性が実証されるまでinteraction外で維持してよい。interaction modeでもRecipe保存やExportにworking snapshotを渡さない。
4. Pointer MoveはNative `develop.curve`を全イベント分送らず、一つのin-flightと一つのlatest pending updateに限定する。Preview workerも既存の一running/一latest pendingを再利用し、Native lock/selection所有者を直列化する。古い画像は既存document/view generationにinteraction id/sequence一致を追加して破棄する。native render自体をcancelできると仮定しない。
5. Pointer Upでは最新配列をdrainして`develop.endInteraction`し、Native readbackで最終完全snapshotを取得する。既存`windows_raw_api._history`のpending/saveIdと`raw_recipe_store._save_history`のtransactionを利用し、operation metadataを`curve`/channelとして一つだけappendする。Finalize分岐はすでに適用されたカーブに対して`apply_history_operation`の`develop.curve`を再実行しない。saveIdの同一Retryはstore receiptを返し、Native再操作なしで完了する。
6. Cancel/Escapeは未送信latestを捨て、Native更新中要求をsettleした後`develop.cancelInteraction`を送り、readbackでbaselineへ戻ったことを確認する。一時Previewを無効化して開始時Previewへ戻すが、durable revision/Recipe/Historyは変更しない。Cancelのtransport結果が不明、readbackがbaselineと異なる、owner/lifecycleが切れた場合はそのNative sessionをsyncedと扱わず、既存のsession resetと保存済みRecipe/History復元へ送る。操作を推測で再適用しない。

残す境界はAsset/Document owner、latest/stale Preview破棄、永続History/Recipe CASとreceipt、Exportの保存Recipe snapshot、Native結果不明時のRecovery、資源/更新回数上限。緩和候補はCurve操作時の全設定完全一致検証、および一時Preview readbackをdurable `_commit`へ結び付ける挙動に限る。既存の復元snapshot一致検証を一括撤廃したり、LightCraftアルゴリズムをGenzoRoomで再現したりしない。

### 残るリスクと未検証事項

- ProbeはManaged Native binaryと合成DNGで成功したが、実カメラDNG、実Desktopのtexture更新、GPU経路、長時間ドラッグ性能は未検証。
- GenzoRoom Backendを通した一時状態・履歴receipt・Preview ticketの競合は未実装/未検証。L0はNative機能の実証であり、L1 completionではない。
- Native sessionのTransport応答不明、同時document切替、Preview render中のcancel、Native edit上限到達時の具体的なrecoveryは今後のBackend限定試験が必要。
- 今回は`backend/`、Frontend、Native patch、Recipe/History schemaを変更していない。P5-CとライブPreview本番実装にも着手していない。
