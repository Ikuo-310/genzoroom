# Color Mixer Integration Research

調査日: 2026-11-14
対象: GenzoRoom `main` (`eda9c20`)、Managed LightCraft v0.20.0

## 実装到達点（P1-B2）

更新日: 2026-11-14。P0調査時点の事実、P1-B1時点の暫定UI、P1-B2で確定した実装を区別する。P1-AはGenzoRoom commit `9c55bcd`、P1-B1は親 commit `0b89865`を前提とする。P1-B2はこの作業で追加されるカラーUI再編とReset契約である。

Windows Nativeカテゴリは「基本補正→カラー→カーブ→エフェクト→ディテール」の5つで、独立したGradingカテゴリはない。Color内はWB状態と操作、温度・色かぶり補正、自然な彩度、彩度、折り畳みMixer、折り畳みColor Gradingの順。Mixer／Gradingは初期折り畳みであり、展開状態・Mixer選択色・Grading帯選択はUIローカル状態で、設定・Recipe・Historyを変更しない。WB行の操作順は状態表示、AW、スポイト、WB Reset。WB Resetは明示的な1 History操作で、RAWは取得済みAs Shot値へ戻し、legacy WBを使う非RAWはNativeの数値既定値(temp 6500, tint 0)へ戻して相対表示0/0にする。AW／スポイトの実行条件は既存どおり。

親Color Resetは`colorReset`としてGenzoRoomの1 History操作にまとめ、WB・vibrance・saturation・Mixer 24項目・公開中のGrading 11項目を既定値へ戻す。WB Resetと同じNative WB初期化手順を共有し、RAWはAs Shot、非RAWはtemp 6500/tint 0でlegacy相対表示0/0とする。Mixer／GradingはNative readbackを照合し、未公開の`grading.global.*`やその他設定は維持する。親ResetではNative `resetSection(color)`の意味を変更せず、Mixer／Gradingの数値とWBのみを限定したNative更新で扱う。Grading固有のsection ON/OFF UIと操作は撤去し、Mixer／Grading／将来のPoint Colorに独立ON/OFFを置かない。Native v0.20.0では親`color` sectionがカラー処理全体（WB、Mixer、Grading、Point Colorを含む）を描画から除外する。Recipe/History内の既存`disabled_sections`に`grading`があっても消去・書換えせず、Recipe復元・Undo/Redoでその保存値を保持する。

P1-B2の実装到達点は、5カテゴリ配置、カラー内にWB操作と折り畳みMixer／Grading、WB専用Reset・親Color Resetを統合したこと。既存のNative数値コントロール、Recipe形式、History append／Undo／Redo、Preview、Export経路を再利用する。変更した操作契約は本節とarchitectureに記載し、以下のP0調査結果は調査時点の記録として残す。次段階はP1-C（将来Point Color）とP2（ターゲットH/S/L調整）であり、どちらもP1-B2の対象外。

**将来検討：カラーサブカテゴリ独立ON/OFF。** 親Color OFFではWB・vibrance・saturation・Mixer・Gradingがまとめて描画対象外になるため、WB調整を保ったままMixer／Gradingの効果だけを比較できないケースがある。将来Mixer、Grading、Point Colorごとに独立ON/OFFを設ける案を検討する。第一候補は元の設定値を維持し、Preview／Exportに渡す設定のみ対象サブカテゴリを中立化する方式。managed patch追加を避けGenzoRoom側で実現することを優先するが、実装方式・保存形式・History境界は未決定であり、LightCraft契約とRecipe／Export経路を調査してから判断する。P1-B2では実装しない。

P1-B2 focused testでは5カテゴリ、WB操作位置とWB Reset／親Color Reset要求、折り畳みGrading、Grading toggle UI撤去、既定値／履歴表示、RAW／legacy非RAWのReset・History・Undo/Redo・旧`grading` bypass値保持を確認する。LightCraft上流、managed patch、Native実行ファイル、SQLite schema、保存済みRecipe/History/receiptは変更しない。モノクロB&W Mix、Point Color、ターゲットモードは今回の実装対象外。P1・P2の確認済み基本仕様にmanaged patch追加は不要である。過去LightCraftバージョンの記録は現在のNative契約として扱わない。

P1-B1検証結果: `AnshitsuRawPreview.test.tsx` 132件、Mixer/ColorのBackend reset・History統合3件とLightCraft Native adapter test 76件が成功。`npm run build`でTypeScript checkと本番buildが成功し、既存bundle-sizeとReact Router directiveの警告が出た。Backendのloopback統合テストはWindows asyncio socketpairのsandbox制約によりsandbox外で実行した。LightCraft Desktop実機での目視確認は未実施。

## 調査対象と整合性

調査時点のGenzoRoom HEADは`eda9c20`。LightCraft checkout `.tmp/lightcraft-0.20.0-p3`はmanifestで固定された`192ff72923c39e6623f2c7ff67ab3a119deb8071`と一致する。`native/lightcraft/manifest.json`にはv0.20.0のpatch `patches/0001-v0.20.0-whole-frame.patch`が1件登録され、そのSHA-256は`ca30ff958ff5fbbd04e8e50b31c7c01a6319b7864b49ef8e506c3f20acc5f2ab`。checkout上で逆適用可能であることを確認した。

`target-p3-wb/release/lightcraft-cli.exe`のSHA-256`30fa30913ceca0f3083ea05d0ebce27fb5668c00b1e78f9d6c2365e43686aa04`は、同梱receiptのmanifest、patch、契約番号、binary SHAと一致する。調査中に上流checkout、patch、manifest、既存Native実行ファイルは変更していない。過去版LightCraftの記録は当時の履歴であり、本書では現行契約の根拠にしない。

## Native数値コントロール契約

LightCraft v0.20.0の`DevelopSettings.mixer`は8色のHSLを保持する。各値は浮動小数点数で、`hue`、`sat`、`lum`の順序に対応する。全24 controlは範囲−100〜+100、既定値0、step 1、小数表示0桁である。Nativeはreadback小数を保持する。

| 色 | Hue | Saturation | Luminance |
|---|---|---|---|
| red | `mixer.red.hue` | `mixer.red.sat` | `mixer.red.lum` |
| orange | `mixer.orange.hue` | `mixer.orange.sat` | `mixer.orange.lum` |
| yellow | `mixer.yellow.hue` | `mixer.yellow.sat` | `mixer.yellow.lum` |
| green | `mixer.green.hue` | `mixer.green.sat` | `mixer.green.lum` |
| aqua | `mixer.aqua.hue` | `mixer.aqua.sat` | `mixer.aqua.lum` |
| blue | `mixer.blue.hue` | `mixer.blue.sat` | `mixer.blue.lum` |
| purple | `mixer.purple.hue` | `mixer.purple.sat` | `mixer.purple.lum` |
| magenta | `mixer.magenta.hue` | `mixer.magenta.sat` | `mixer.magenta.lum` |

`develop.controls`のsection `mixer`は各controlのID、数値境界、既定値、step、現在値を列挙する。`develop.get`は完全なNative設定を入れ子の`mixer`として返す。`develop.set`はID/valueまたはID/value mapで絶対値を設定し、`develop.resetControl`は指定IDを既定値へ戻す。`develop.merge`は部分設定をマージし、GenzoRoomでは完全snapshotの復元に使用する。これらは現行Nativeコマンドで確認した契約である。

## Preview、Export、Recipe、History

LightCraftのCPU/GPU pipelineはDevelopSettingsからColorOpsを構成し、8色Mixerを描画する。PreviewのDraft／Full双方とExportは同じNative現像設定を通る。既存managed patchはWhole/Crop Frame、Before/After、Draft/Full、Region、WB candidateを補うもので、Mixerの数値controlや処理を追加していない。

GenzoRoom WindowsはRAWと非RAWで同じLightCraft Native Sessionを使う。`develop.get`の完全snapshotを既存Recipe／Historyへ保存し、再オープン・Undo/Redo/JumpではNativeへ復元する。Exportは保存済みRecipeを独立Native Sessionへ復元し、Native Exportを呼び出して前後の設定を比較する。Recipe形式やSQLite schemaは増やさない。古いRecipeからmixer全体またはband/fieldが欠落する場合は、Nativeの既定値0を比較・復元時に使う。保存済みRecipe、History、receiptを遡及的に書き換えない。

NativeはColor sectionが無効ならMixerを含むカラー処理を描画から外す。独立Mixer ON/OFFは設けない。Native `resetSection(color)`はColorとWBをリセットし、独立Section Mixerは対象外である。GenzoRoom既存ResetもWB、vibrance、saturation等を確認し、mixer値を保持する。この挙動を変更しない。Mixer個別Resetは`develop.resetControl`で0へ戻す。

## ターゲット調整のNative契約

`develop.targeted`は`target: hue|sat|lum`、正規化画像座標`x`,`y`、相対`delta`を受け、変更control IDとreadback値のmapを返す。H/S/Lの各操作が複数色帯を変更し得る。LightCraftのDesktopは`develop.beginInteraction`から更新を行い、`develop.endInteraction`で1 Undo stepにする。途中取消は`develop.cancelInteraction`で開始状態へ戻す。

色の選択はNativeが各呼び出しで行う。NativeはMixerとその後段の色処理を中立化し、長辺最大384pxのproxyを描画する。指定座標の周囲3×3ピクセルを平均し、sRGB値をOkLChへ変換する。色相から8帯のOkLCh hue重みを得る。最大重み帯にはdelta全量、その他は最大重みとの比率を掛け、5%未満は無視する。結果は`mixer.<color>.<hue|sat|lum>`へ加算され、Nativeのcontrol境界でclampされる。GenzoRoomには別の色判定APIや色処理実装は不要である。

## Desktop操作とGenzoRoom方針

LightCraft Desktopは8色選択と選択色のH/S/Lを表示し、写真上ターゲットは選択スウォッチとは独立する。ドラッグ開始位置を保持し、縦移動0.5pxごとに整数stepを送り、Interaction全体をUndo 1件にする。モノクロではB&W Mixへ切り替える。

GenzoRoom P1は既存Colorカテゴリ内に8色選択とH/S/L数値スライダーを追加する計画である。P2はH/S/Lターゲットモードを加える。既存Viewer契約に従いhoverは標準crosshairと`ViewerPointLoupe`を追従させ、Pointer Downで画像点とルーペ表示位置を固定し、ドラッグ中は`ns-resize`、Pointer Upで1 History操作、Escapeで取消とする。Native readbackに基づく複数色帯更新を扱う。ルーペは現行共通実装（120 CSS px、4倍、中央十字）を再利用する。現行gapは26pxである。過去文書の36px記述は現在のUI仕様ではない。

## 調査時点の実装計画（P1-A着手前）

**P1 — 8色HSL UIとNative Recipe連携。** P1-AでBackend/Frontendの既存数値control allowlist、nested paths、readback、validation、individual reset、History control IDs、Recipe復元、Export比較を24 IDへ拡張する。欠落Mixerは0を既定化し、DB schemaや保存済みrecordは変更しない。Nativeは既存APIを使用し、managed patch追加は不要。P1-BでColorカテゴリに8色選択、H/S/L sliders、各control resetを加え、既存150ms patch集約と最終flushを使う。UIは本書のP1-A段階には含めない。

**P2 — ターゲット調整。** H/S/Lの排他的なモード、Viewer pointer lifecycle、fixed-origin loupe、Native targeted update、readback、Draft Preview、Pointer Upで1件のHistory、Escape/cancelを実装する。既存Curve Interactionのsession ownership、順序保証、cancel/recoveryを必要な範囲で再利用し、WB pickerとの排他を保つ。Native APIの基本機能にmanaged patch追加は不要。モノクロB&W Mixは今回の範囲外。

## 検証済み事項と未確認事項

検証済み: checkout commitとmanifest一致、managed patch SHAと逆適用、Native binary receipt/SHA一致。CLI/MCP上で24 Native controls、set/get/reset、H/S/L targeted readbackが複数色帯へ及ぶこと、Cancel復元、Interaction End後Undo、変更後のDraft/Full previewを確認した。これらは合成demo上のNative確認であり、GenzoRoomの新規統合テストやWindows Desktop実機確認ではない。

未確認: 実RAW/非RAWを用いたGenzoRoomでのMixer Preview/Export、P1-Aのテスト実行、Desktop UI受入、色帯境界におけるNative sampleと表示ルーペの差、連続ターゲット更新時の実写真での応答。Native readbackのH/S/L targeted更新には複数bandと小数が含まれるため、P2では全変更値を保持し、単一controlを仮定しない。

## 主要ソース

- Native設定/control: `.tmp/lightcraft-0.20.0-p3/crates/develop/src/settings.rs`, `controls.rs`
- Nativeコマンド・色判定: `.tmp/lightcraft-0.20.0-p3/crates/engine/src/cmd/query.rs`, `develop.rs`, `color.rs`
- Native描画: `.tmp/lightcraft-0.20.0-p3/crates/pipeline/src/colorops.rs`, `finish.rs`, `.tmp/lightcraft-0.20.0-p3/crates/mcp/src/headless.rs`
- Desktop UI: `.tmp/lightcraft-0.20.0-p3/crates/ui-egui/src/panels/edit/mixer.rs`, `panels/detail.rs`
- Native管理: `native/lightcraft/manifest.json`, `native/lightcraft/patches/0001-v0.20.0-whole-frame.patch`
- GenzoRoom Backend: `backend/raw_controls.py`, `lightcraft_raw.py`, `windows_raw_api.py`, `raw_recipe_store.py`, `raw_export_artifact.py`
- GenzoRoom Frontend: `frontend/src/rawApi.ts`, `rawControls.ts`, `useRawDocument.ts`, `rawRecipeSave.ts`, `RawAdjustmentControls.tsx`, `ImageViewer.tsx`, `ViewerPointLoupe.tsx`, `rawTargetCoordinates.ts`
