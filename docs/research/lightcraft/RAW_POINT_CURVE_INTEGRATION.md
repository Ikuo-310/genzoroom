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

| Phase | 目的・変更範囲 | 完了条件 |
|---|---|---|
| P0 | 調査結果の研究文書化 | 契約・統合案・既知課題・後続計画を記録 |
| P1 | 設定型と入力/readback検証 | 4チャンネル型、座標・個数・サイズ検証をAPI境界で確認 |
| P2 | Native操作と既存History接続 | Native mutation/readback後に完全snapshotを1操作として保存し、Undo/Redo/Jump可能 |
| P3 | Reset・旧Recipe・Export照合 | 単一/全ポイントReset、旧Recipe復元、Export readback照合を確認 |
| P4 | SVGグラフUI | 4チャンネル共通の追加・選択・移動・削除UIを実装 |
| P5 | Viewer接続とドラッグ | Move中はローカルのみ、Upで一度確定、CancelはHistoryなし |
| P6 | 統合検証と実Desktop受入 | 関連テスト・ビルドとDesktop上の操作を確認 |

パラメトリックカーブは全Phaseで対象外。ヒストグラム背景と写真上ターゲット調整はP1〜P6の範囲に含めず、後段へ保留する。

## 証拠の限界

本調査はLightCraft上流ソース比較とGenzoRoomローカルコード読解に基づく。今回、Native実binary probe、Preview/Export実行、テスト、実Desktop操作は行っていない。上記の未完成差分課題は解決済みを意味しない。
