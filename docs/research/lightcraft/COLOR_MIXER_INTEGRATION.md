# Color Mixer Integration Research

## 現行仕様とP2-C監査結果

| 段階 | 到達点 |
| --- | --- |
| P0 | LightCraft v0.20.0のNative契約を調査 |
| P1-A | 8色×H/S/Lの24数値コントロールを統合 |
| P1-B1 | Color内にMixer UIを追加 |
| P1-B2 | Color UIを再編し、親Color・Mixer・Grading・WB Resetを統合 |
| P1-C | P1の統合検証とWindows Desktop受入 |
| P2-A | Native Mixer Interaction、readback、Historyを統合（`a7433e0`） |
| P2-B | H/S/LターゲットUIと共通Viewerを接続（`3e99d27`） |
| P2-C | `06abae7` を基準に最終回帰検証と文書整理を実施 |

CurveとMixerは同じViewer座標変換とNative Sessionの排他を使う。Beginで正規化座標とモードを固定し、上向きの移動を正deltaへ変換する。現行実装は1 CSS pxあたり0.5ステップを蓄積し、整数部分を送る（1ステップに2 CSS px）。過去の「0.5 CSS pxで1ステップ」は現行実装と異なる。ドラッグ感度の変更は別途判断する。

共通ルーペはHoverに追従し、Begin成立後は非表示になる。Pointer Up後、モードが続いていれば再表示できる。直径120 CSS px、4倍、中央十字、配置gap 26 CSS px。WBスポイトは従来の採色経路を使う。

Nativeが帯選択と重みを決め、GenzoRoomは同一モードの複数帯readbackを小数のまま扱う。Updateを直列化し、sequence付きDraftを表示する。Endは設定に差分があればHistory 1件を確定し、確定RecipeからFull PreviewとExportへつなぐ。Cancelは開始時の設定へ復元する。B&W treatmentのBeginは拒否する。パネル開閉・Mixer選択色はアプリ設定、ターゲットモードは一時状態とする。

P2-B後の修正は、History GETの `mixerTarget` 検証漏れ（`c746c47`）、日英の操作名のみのHistory表示と未知kindの誤表示（`8848970`）、ドラッグ中に写真を覆うルーペ（`06abae7`）。以降の各節は当時の記録として残す。

P2-CではFrontend 709件、模擬Nativeを含むBackend 257件、実Native CLIのJPEG検証3件が成功した。Windows Desktopでのターゲット操作・複数帯反映・History再読込・Undo/Redo・Preview・ルーペはユーザー確認済み。実RAWでのP2操作と、RAW／非RAWそれぞれのターゲット編集からRecipe再オープン・JPEG書き出しまでの一連の実画像確認は今回未実施。

将来検討では、Hueのみ8色別の変化方向をNativeと揃えたグラデーションを検討する。Mixer／Grading／将来のPoint Colorの独立ON/OFFはmanaged patchを避ける案を優先し、ResetとUndo/Redoで比較できるため優先度は低い。方式と保存形式は未決定。Point Colorは別フェーズでNative API契約の調査から始める。

## 調査と段階別実装の記録

調査日: 2026-11-14
対象: GenzoRoom `main` (`eda9c20`)、Managed LightCraft v0.20.0

## 現行実装とP1-C統合監査

| 段階 | 到達点 |
| --- | --- |
| P0 | LightCraft v0.20.0のNative数値・ターゲット操作契約を調査 |
| P1-A（`9c55bcd`） | 24項目を既存のNative数値コントロール経路へ接続 |
| P1-B1（`0b89865`） | 8色選択とH/S/Lスライダー、Mixer専用Reset |
| P1-B2（`4240c77`） | 5カテゴリ、Color内のGrading、WB専用Resetと親Color複合Reset |
| P1-C（監査基準 `c9e84e6`） | 設定契約の回帰検証、RAW・非RAWのExport fixture拡張、現行仕様の整理 |

Historyの複数項目Resetは操作名のみを表示する（`c633bff`）。5親カテゴリとMixer／Grading／レンズ補正／Defringeの開閉、Mixer色、Grading帯は写真に紐付かないversion 1のUI設定として復元する（`c9e84e6`）。保存値がないときMixer／Gradingは閉じている。

- **数値と編集境界**。24 ID、−100〜+100、step 1、既定値0を確認。整数表示でもreadbackの小数は保持する。色切替・Reset・パネルの閉鎖・写真切替では既存の編集確定経路を使用する。Draft／Fullの更新と失敗・再試行の回帰を確認した。
- **Resetと保存**。RAWのAs Shot、非RAWの相対WB 0/0、Mixer／Grading専用Reset、親ColorのON/OFFおよび複合Resetを確認。設定のreadbackをHistoryに反映し、既存のUndo／Redo／JumpとRecipe復元を通す。親Color Resetは未公開Grading Global、旧Grading bypass、他カテゴリを保持する。
- **PreviewとExport**。Previewは編集Sessionの設定を使用し、Exportは保存設定を独立Sessionへreset→mergeで復元し、Export前後に照合する。RAW・非RAWのfixtureで小数Mixer値とGradingの引き渡し、欠落Mixerの0補完を確認した。対象原本での描画比較はWindows Desktop受入項目として残る。
- **UI設定**。写真切替、再マウント、保存値の再読込、不正値の既定値復帰、編集値の写真間分離を自動検証。写真切替時のカテゴリ開閉保持はユーザーの実機確認済み。

関連Frontend 320件、Backend 304件が成功。Backend件数はExport修正後の再実行61件と初回の他5ファイル243件の合計。TypeScript、本番ビルド、`git diff --check`も成功した。

**当時の将来計画**。P2はViewerでのH/S/Lターゲット操作、共通ルーペ、複数帯readback、操作単位のHistoryを扱う計画だった。P2-AでBackend/API/History基盤を追加済み。P2-BでViewer操作を接続する。MixerのHueカラーバー、Point Color、サブカテゴリ独立ON/OFFは今回の実装範囲外。

## P2-A実装結果：Native MixerターゲットInteraction基盤

実装基準: GenzoRoom `fd748e3a15547573f6e5d12502bfe5dcc9a3e3b2`、LightCraft manifest固定commit `192ff72923c39e6623f2c7ff67ab3a119deb8071`。P2-AではLightCraft source、managed patch、manifest、既存Native executable、SQLite schemaを変更していない。P1-Cまでの調査結果と区別して、以下をGenzoRoom側の現在のAPI契約とする。

- `/documents/{handle}/mixer-interaction/begin|update|preview|cancel`を追加。Beginはdocument handle/token/generation/revision、`target: hue|sat|lum`、0〜1の正規化`x`,`y`を検証して座標とモードをInteractionへ固定する。Native `develop.beginInteraction`を呼び、基準設定をreadbackする。
- Updateは単一の有限`delta`（0以外）と単調な`sequence`（1始まり）を受ける。要求はInteraction内lockで直列化し、sequence飛越・逆転を拒否する。Native `develop.targeted`へ固定座標とdeltaを渡す。毎回のRelative deltaを統合・間引きしない。deltaの解釈・調整量のclampはNativeに委ねる。
- `develop.targeted`応答の変更mapは全control IDを検証する。許可するのは`mixer.<8色>.<Beginで固定したH/S/L>`のみで、数値・有限性・−100〜+100の範囲を確認する。Native `develop.get`の完全設定を別途readbackし、Mixerの24 control値を検証、応答mapと一致する各変更値を確かめる。readbackの小数は保持し、GenzoRoomで色判定や帯重み計算を行わない。
- Previewは既存のPreview worker/ticketを用いるDraft。Interaction IDとsequenceをresponse headerで照合する。Cancelled/古いsequence/古いticketは既存のticket generation・sequence fenceで破棄する。Full Previewは確定後の既存呼び出し側が要求する。専用rendererはない。
- CurveとMixerは同じNative Sessionで`develop.beginInteraction`を使う。Beginを同一`_curve_state_lock`で直列化し、Sessionのcontrol reservation・通常操作フェンスにも同じ所有権を加える。Interactionごとのpayload/readback stateは別構造で保持する。Active中の二重Begin、他Interaction開始、通常control edit、写真選択変更は拒否する。
- CancelはNative `develop.cancelInteraction`後に完全設定readbackを開始状態と照合し、Historyを作らない。Native transport/応答不明や適用後readback異常ではdesynchronizedとして通常編集を止め、既存Session Recoveryへ渡す。
- Endは`/history/operate`の`kind: mixerTarget`, `metadata: {target}`, `mixerInteractionId`として実行する。Native `develop.endInteraction`後の完全snapshotをHistory appendに使い、DB append成功後にだけInteractionを確定snapshotへ昇格する。変更なしなら既存append処理がstepを作らない。Undo/Redo/Jumpは既存Recipe snapshot restoreを使う。Recipe/Exportは確定Recipeから従来の`develop.merge`経路を使用する。
- RAW／非RAWは同じWindows Native SessionとAPIを使用する。LightCraftはB&W treatmentまたは`lc.mono` profileでは`bw.*`を更新するため、Mixer H/S/L専用のBeginは拒否する。B&W Mixは今回の対象外。

P2-A時点ではFrontend API型・関数までを追加し、Mixer UI・Viewerからは呼び出していなかった。当時のP2-B計画ではsequence順序、pending deltaのPointer Up flush、Curve point arraysとMixer状態の分離、WB pickerとの排他、共有ルーペ、Escape、Document departureを接続要件としていた。現在の確定実装は次節に記録する。

P2-Aのテストはmock Native readbackによるBackend unit/API testと、固定v0.20.0実Native CLI testを分けて実施した。実Native CLIはHue/Saturation/Luminance各Interactionの複数control readback、Draft Preview、End/confirmまで成功。Desktop UI実機、RAW原本、および画素比較は未実施。今後のNative contract不整合に備えたmanaged patch追加は不要。

## P2-B実装結果：H/S/LターゲットUI・Viewer統合

実装状態: P2-A APIをWindows Native現像UIに接続した。LightCraft Native／managed patch／実行ファイル、SQLite schema、Docker JPEG経路は変更していない。モノクロB&W Mix、Point Color、Hue color bar、独立Subcategory ON/OFFは対象外のまま。

- Mixer展開領域は8色スウォッチ、ターゲット操作列、選択色のH/S/L slider順。操作列は既存スポイトアイコンを案内として描画し、H/S/Lボタンのみがモード切替を行う。同一モード再クリックで解除し、モードはReactの一時状態でRecipe／History／UI設定へ保存しない。
- H/S/Lモードは排他的で、Color OFF、編集ロック、Before、Crop、WB picker、curve target、Mixer subsectionまたはColor categoryの折り畳み、Space pan、Escape、写真・Document切替でpointer ownerを止める。曲線制御点編集はMixer target mode中に無効。Native Sessionのcurve／mixer interaction排他はP2-AのBackend lockに加え、Frontendでは`RawRecipeSave.locked`を共通編集境界に使う。
- Viewerは既存`rawTargetCoordinates.ts`を使い、Whole表示画像から正規化Native座標を計算する。Native Desktop v0.20.0に合わせ、Pointer Moveの上方向を正deltaとし、0.5 CSS px単位を1段へ変換する。ドラッグ開始後は座標と共通`ViewerPointLoupe`位置を固定し、Crosshair／`ns-resize`カーソルを既存Viewerで切り替える。新しいルーペや色判定は追加していない。
- `RawRecipeSave`が通常Control save fenceを通してからNative Beginし、50ms cadenceで更新要求を1本ずつ処理する。待機中の移動は単一の累積deltaへまとめ、順序付きNative sequenceを保つ。全Mixer controlの小数readbackを累積して一時UIへ反映し、選択色は変えない。各readbackのDraft Previewは既存mixer Preview API／ticketに接続し、interaction sequenceが現在値と一致する画像だけを採用する。
- Pointer Upは待機中delta、in-flight Update、最終Draftを処理後、P2-Aの`mixerTarget` History Endへ渡す。Native最終snapshotがHistory/Recipeの正となり、History append成功後に既存Full Previewを更新する。変更なしはNative側no-op History契約に従う。Escape／pointer cancelはNative Cancel後のreadbackで開始値へ戻し、Historyを増やさない。Previewの遅延Decodeはowner無効化後に破棄する。
- P2-B focused Frontend検証では`AnshitsuRawPreview.test.tsx`、`useRawDocument.test.tsx`、`ImageViewer.test.tsx`の363件が成功。TypeScriptと本番buildは成功し、既存のbundle-sizeおよびReact Router directive警告あり。Desktop実機、RAW／非RAW原本、Preview画質・追従、Undo/Redo/Jump、Before／Crop／Space／Escape組合せは未実施で、ユーザーによるWindows Desktop確認項目。

P2-Bの主要な実装参照先は`frontend/src/RawAdjustmentControls.tsx`、`frontend/src/AnshitsuPage.tsx`、`frontend/src/ImageViewer.tsx`、`frontend/src/useRawDocument.ts`、`frontend/src/rawRecipeSave.ts`、`frontend/src/rawApi.ts`、`frontend/src/rawTargetCoordinates.ts`、`frontend/src/ViewerPointLoupe.tsx`。回帰テストは各ソースの`.test.tsx`を参照する。

## P1-B2時点の実装記録（履歴）

更新日: 2026-11-14。P0調査時点の事実、P1-B1時点の暫定UI、P1-B2で確定した実装を区別する。P1-AはGenzoRoom commit `9c55bcd`、P1-B1は親 commit `0b89865`を前提とする。P1-B2はこの作業で追加されるカラーUI再編とReset契約である。

Windows Nativeカテゴリは「基本補正→カラー→カーブ→エフェクト→ディテール」の5つで、独立したGradingカテゴリはない。Color内はWB状態と操作、温度・色かぶり補正、自然な彩度、彩度、折り畳みMixer、折り畳みColor Gradingの順。Mixer／Gradingは初期折り畳みであり、展開状態・Mixer選択色・Grading帯選択はUIローカル状態で、設定・Recipe・Historyを変更しない。WB行の操作順は状態表示、AW、スポイト、WB Reset。WB Resetは明示的な1 History操作で、RAWは取得済みAs Shot値へ戻し、legacy WBを使う非RAWはNativeの数値既定値(temp 6500, tint 0)へ戻して相対表示0/0にする。AW／スポイトの実行条件は既存どおり。

親Color Resetは`colorReset`としてGenzoRoomの1 History操作にまとめ、WB・vibrance・saturation・Mixer 24項目・公開中のGrading 11項目を既定値へ戻す。WB Resetと同じNative WB初期化手順を共有し、RAWはAs Shot、非RAWはtemp 6500/tint 0でlegacy相対表示0/0とする。Mixer／GradingはNative readbackを照合し、未公開の`grading.global.*`やその他設定は維持する。親ResetではNative `resetSection(color)`の意味を変更せず、Mixer／Gradingの数値とWBのみを限定したNative更新で扱う。Grading固有のsection ON/OFF UIと操作は撤去し、Mixer／Grading／将来のPoint Colorに独立ON/OFFを置かない。Native v0.20.0では親`color` sectionがカラー処理全体（WB、Mixer、Grading、Point Colorを含む）を描画から除外する。Recipe/History内の既存`disabled_sections`に`grading`があっても消去・書換えせず、Recipe復元・Undo/Redoでその保存値を保持する。

P1-B2の実装到達点は、5カテゴリ配置、カラー内にWB操作と折り畳みMixer／Grading、WB専用Reset・親Color Resetを統合したこと。既存のNative数値コントロール、Recipe形式、History append／Undo／Redo、Preview、Export経路を再利用する。変更した操作契約は本節とarchitectureに記載し、以下のP0調査結果は調査時点の記録として残す。P1-Cは統合監査、P2はターゲットH/S/L調整、Point Colorは別フェーズとする。

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

## P0時点の検証済み事項と未確認事項（履歴）

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
