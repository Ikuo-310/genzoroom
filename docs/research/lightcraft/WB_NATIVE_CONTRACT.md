# WB Phase 1 Native contract

LightCraft v0.14.0 / `03c88c166c054c009db2a47187d59991f6232b85` の管理パッチに追加する、headless MCP専用の読み取りhelper。Frontend、HTTPのWB操作、RAW History kind、Recipe保存への接続は含まない。

## 所有権と不変条件

- tool: `estimate_white_balance`、入力marker: `wb_contract: 1`、応答: `wbContract: 1`。
- `id`は現在のLightCraft session内の正のphoto IDの十進文字列。active photoへの暗黙fallbackや選択変更はしない。
- `settingsFingerprint`は`get_develop`で取得する完全なnative DevelopSettingsを`serde_json::Value`へ変換し、再帰的にkey順で並べたcompact JSONをUTF-8でSHA-256化した64桁小文字hex。RFC 8785ではない。呼び出し側は`get_develop`のnative JSON text（既にkey順）から文字列外の空白だけを除去し、数値・文字列tokenを保持してhash化する。構造化objectを別言語で再JSON化してはならない。`wb_probe.py::result_fingerprint()`が参照実装で、指数表記`1e-7`を含む実binary照合と、引用符・escape・文字列内空白・負のzeroの単体試験を行う。
- `requestId`は32桁小文字hex。identityは入力全体をechoする。GenzoRoomのAsset/document/generation/revisionは将来のBackendが管理し、Nativeへ重複実装しない。MCP直列化はstale対策の代わりにならない。
- Phase 2接続時の補足: `develop.get`はProcess V1でも表示用に`process:1`を加えるが、Native helperのhash対象である`DevelopSettings`の保存表現ではこのfieldを省略する。Backendの共通fingerprint実装はトップレベルの当該fieldだけをtoken単位で取り除く。他の数値・文字列やネストしたfieldは保持する。Native契約・version・patch・binaryの変更は不要で、V1/V2とも実binary probeで照合する。
- 編集settings、import defaults、as-shot情報、photo History、Session Undo/Redo、選択を変更しない。`source_now()`と`accept()`は呼ばない。source cacheの参照/LRU更新、decode、Planの内部cacheは読み取り処理の副作用として許容する。
- WB候補だけを返す。将来の適用側はidentityとrevisionを再検証し、既存mutation/readback/save fenceを利用する。

## 入力

AW:

```json
{
  "id": "1",
  "wb_contract": 1,
  "operation": "auto",
  "settingsFingerprint": "<64 lowercase hex>",
  "requestId": "<32 lowercase hex>"
}
```

Pickerは同じ共通fieldに以下を加え、`operation`を`pick`にする。

```json
{
  "frame": {
    "kind": "after",
    "geometryId": "<displayed geometryId>",
    "maxSide": 2048,
    "quality": "full",
    "x": 0.45,
    "y": 0.55
  }
}
```

`kind`は`before|after`、`quality`は`draft|full`。`maxSide`は16～65536の整数で、表示geometryを作ったWhole render/Region Planのsource選択を再構築できる長辺要求を渡す。任意に表示PNGの辺長へ置き換えない。source選択や自動CA/Uprightが異なってgeometryが一致しなければ拒否する。

`x/y`はWhole出力の連続した正規化座標（0～1）。pixel中心は`(i+0.5)/width`。Zoom/Pan/DPR、Region PNGのローカル座標を渡さない。外側入力は拒否し、画像内入力でも逆写像後にsourceの半開区間`[0,1)`外へ出た場合は拒否する。中心を端へclampしない。5×5近傍の画像端処理は既存Pickerの`get_clamped()`を維持する。

autoにframeを渡す、pickのframe省略、unknown field、非有限値、不正な型・範囲・identityは拒否する。MCP schemaに加えNative実行入口でも検証する。

## 応答とエラー

成功はMCPのJSON textと`structuredContent`で同じobjectを返す。

```json
{
  "wbContract": 1,
  "identity": {"<全入力field>": "<同じ値>"},
  "candidate": {"mode": "auto", "scale": "kelvin", "temp": 5100.0, "tint": 8.0}
}
```

`mode`はautoで`auto`、pickで`custom`。`scale`はnative `normalize_wb()`に従い`kelvin|legacy`を必ず明示する。Temperatureは2000～50000、Tintは−150～150の有限値。Legacy候補をKelvinへ偽装しない。

失敗は`isError:true`、単一text `{"code":"wb_..."}`、candidateなし。公開するcodeは以下に限定する。

| code | 意味 |
|---|---|
| `wb_invalid_request` | schema/型/範囲の不正 |
| `wb_settings_mismatch` | settings fingerprint不一致 |
| `wb_geometry_mismatch` | geometry再構築不能・ID不一致 |
| `wb_point_outside_source` | 逆写像が非有限、projective horizon、source外等 |
| `wb_source_unavailable` | photoなし、decode不能、既存のcold Full source予約budgetを超過 |
| `wb_no_valid_samples` | Grey-worldの有効な重みなし。as-shot fallback候補は返さない |
| `wb_estimation_failed` | 結果の非有限/範囲外、その他の内部失敗 |
| `wb_unsupported` | 対応しないBackendへの呼び出し |

内部例外文字列、path、画素をエラーへ転写しない。Remote desktop Backendではadvertiseせず、headless実装だけを公開する。

## 再利用と座標変換

`pipeline::auto::try_auto_wb()`は既存`auto_wb()`の推定本体を共有し、有効標本なしを`None`で返す。既存`auto_wb()`は従来どおりas-shotへfallbackする。`wb_pick_sample()`へ既存Pickerの5×5平均を移し、既存コマンドとhelperの両方が使う。カメラ色モデル/Bradford、重み、縮小、丸め、範囲は維持する。

推定は常にplain Thumb source。decodeから得た`SourceInfo`を優先するが、学習・catalog書き換えは行わない。Pickerのgeometryは別途、`render_job()`と`pipeline::plan()`で表示と同じsource・effective settings・Frame/Warpを再構築する。Beforeは`before_settings()`を使用。`frame_metadata()`のdescriptor 2とgeometry IDを照合する。

`Frame::wb_source_point()`は`out_to_oriented()`のcrop/angle/flipと`Warp::to_source(..., 1)`のinverse perspective/レンズ歪曲を使用する。描画のframingと同じgreen-plane位置を基準とする。per-channel CAのRGB別位置やvignette gainを、WB用の5×5標本へ新たに適用しない。orientation適用済みsource正規化座標をThumbへ対応させ、既存Pickerと同じ採取を行う。

## 性能・制約

AWはFull生成を要求しない。Pickerも推定自体はThumbだが、表示geometryの再構築にFull sourceを必要とする場合がある。既存cacheを利用し、cold FullにはRegionと同じ予約条件を適用する。新cache・StageCache budget・schedulerの変更はしない。helperは新しいdecoded sourceをsessionへacceptしないため、cold sourceの連続要求がdecodeを繰り返す可能性がある。cancelのhard interruptは提供せず、将来の呼び出し側がstale結果を破棄する。

geometry検証でfail closedとなる場合、異なるsource/解像度のFrameへ自動fallbackしない。実RAW、auto CA/Uprightを含む全カメラ・source解像度の組合せ、Windows/Firefoxの表示クリックはPhase 1の合成試験だけでは保証しない。

## 管理artifact

Before=1、Preview=1、Region=1、geometry descriptor=2は維持し、manifestへ`contracts.wb=1`、receiptへ`wbContract=1`を追加する。旧receiptは新manifestで拒否する。独立`developmentTargetDir=target-wb-phase1`へbuild/probeし、全probe成功後にのみ隣接receiptを発行する。従来`target/release`のEXE/receiptは保持する。独立候補の探索にもmanifest、receipt、実SHA照合が必要。

`build.py --source .tmp/lightcraft-0.14 --build`で管理diff検証、MCP試験、WB focused Pipeline試験、独立release build、既存Before/Whole/Region probe、新WB probeを実行する。`wb_probe.py`は実binaryのschema、候補、identity、成功/失敗時settings不変、Before/After、既存AWとの一致、CPU/DX12描画を合成PNGで確認する。実RAW画質・手動ブラウザ確認とは区別する。

## Phase 1自動検証結果（2026-10-27）

- Native MCP: 81 passed / 1 ignored、integration: 11 passed。ignoredは既存の子process試験用entryで、直接実行する通常テストではない。
- Pipeline WB focused: 7 passed、カメラ色モデルによる既知白色点の推定・補正: 1 passed。
- Backend artifact/patch/RAW adapter focused: 91 passed。fingerprint token保持のfocused単体試験: 5 passed。Frontendの実装変更はない。
- 既存Before/Whole/Region実binary probe: CPU/DX12ともPASS。WB probe: CPU/DX12とも14項目PASS、成功/失敗時settings不変。推定計算はCPU、DX12は描画・geometryとの整合を確認したもの。
- RAW Preview focused smoke: 全stage PASS。readinessは実artifact、それ以外のViewer lifecycle/復元/Resetは既存fixtureによる自動検証であり、実RAWやブラウザ目視ではない。
- manifest、receipt、実binary SHA、runtime artifact探索の照合PASS。従来`target/release`のEXE/receiptのSHA不変を確認。

採用候補binary SHA-256: `b872315ccd11c5c2e945f473d8ca48022127a4cc196b95d16ff3d8fb75004251`。
管理patch SHA-256: `9308d0663de3e4d1f6fd65e564fb04cc7ac1c993b5c1a2aae29ef1f72b521063`。

未完了の受入: 実RAWの画質・標本位置・camera metadataの実測、auto CA/Uprightを含む実写真でのsource-level差、Windows/Firefoxでの手動確認。UI接続後のクリック位置・Zoom/Pan/DPRの受入は後続Phaseで行う。後続Backend接続時もfingerprint参照実装のnative token保持規則を維持する。

試験環境ではsandboxのTEMP作成とloopback socketが拒否されたため、単独再現後に通常権限環境で関連試験を再実行して通過した。build時には既存のcraft-fonts未設定とincremental cacheのhard-link不可警告がある。WB計算・契約試験への失敗は残っていない。

残存Finding: `cargo clippy --locked -p lightcraft-mcp -p lightcraft-pipeline --lib --no-deps -- -D warnings`は、作業前の管理パッチに存在する5件で失敗する（`preview.rs`の`collapsible_if` 2件、`region.rs`の`collapsible_if` 1件、`tools.rs`の`let_and_return`と既存Region dispatchの`needless_return`）。新規WB dispatchの同種警告は修正済み。既存箇所の変更は本Phaseに含めない。
