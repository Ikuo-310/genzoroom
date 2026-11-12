# LightCraft v0.20.0 エンジン載せ換え計画

正式改訂：2026-11-10（Asia/Tokyo）。対象は `feature/lightcraft-v020-port`。恒久的な責務・接続原則は [統合契約](LIGHTCRAFT_INTEGRATION_CONTRACT.md) を正本とする。本節のみを今後のv0.20.0移植計画とし、以下の旧N1〜N6および旧P0・P1〜P12は実施当時の計画・検証履歴として保持する。それらの工程、必須metadata、hunk移植、v0.18.1環境維持の指示は新計画に適用しない。

### H1限定修正記録（2026-11-12）

監査Finding `LIGHTCRAFT_DEPENDENCY_AUDIT.md` §4 H1に対し、完全snapshot wire変換で省略`detail.nr_outliers`をfalseとしてmergeし、保存snapshot／History本文／receipt／fingerprintは変更しない。通常partial mergeはそのまま。Reset検証はNative省略falseと期待falseを同値化したうえで全settings一致を維持し、誤ったtrue・他項目変更を拒否する。Exportの独立sessionも同じ変換を使い、process境界と原本保護を維持する。P4-C、P5統合、他Findingには着手しない。

Backend focused test 65件成功。実EXE `target-p3-wb`はmanifest receipt／SHA／schema probe成功。実Native＋リポジトリJPEG一時コピー1件でDetail Reset、部分更新、false／true snapshotの復元を確認した。RAW DNG素材による`nr_outliers=true` import／reset、Pixel／Pentax、実Native Thumbnail／Export、実ユーザーtupleは未確認。詳細と残る検証範囲は上記監査文書を参照。

### P5-A：既存Exportテスト期待値の修正（2026-11-13）

直前のP5関連Backend suiteで失敗した3件を再現し、製品動作と照合した。旧Engine tupleだけがあるRAW Assetは`select_raw_export_state()`が`exportEligible=false`を返し、Export Queueへの登録を拒否する。旧RecipeをQueue登録・Exportできるとしたテストを、拒否とQueue不変を確認する期待へ修正した。H1関連の2件は`raw_export_artifact`が完全snapshot送信時に`complete_snapshot_for_merge()`を適用するため`detail.nr_outliers=false`がpayloadに加わる。Export Nativeへのwire payloadだけでfalse補完を検証し、保存Recipe本文・receiptが不変である既存assertを維持した。

対象9ファイルのBackend Thumbnail／Export／Queue／Immich／STACK回帰は修正後**344 passed**。この段階ではテスト・文書のみの変更で、実Native Thumbnail／ExportおよびP5-B以降の統合は実施していない。

## 目的とバージョン方針

既存の編集、Preview、保存、Export、Immich登録をv0.20.0で成立させる。旧Native内部契約の全面移植は廃止し、標準APIで足りない接続だけを最小限のpatchで補う。`main`は変更せず、このfeatureブランチをv0.20.0専用構成へ移す。P1でmanifestと基本Native接続をv0.20.0へ切替えた。後続機能は各工程で接続する。

| 基準 | 正式tag | 固定upstream commit |
|---|---|---|
| P1以前のmanaged構成 | v0.18.1 | `57024f072c234e0c6c850e0940a261790f976575` |
| P1のmanaged構成 | v0.20.0 | `192ff72923c39e6623f2c7ff67ab3a119deb8071` |

feature側でv0.18.1の実行契約や旧Nativeとの互換性を維持する必要はない。旧DB・Recipe・Historyとの後方互換性が複雑化の原因となる場合は破壊的変更を許容する。変更前に対象・影響・復旧方法を確認し文書化し、無関係なデータを削除しない。v0.20.0で新規作成した保存データの正常な保存・復元は必須とする。旧版との画質一致は要求しない。

## 工程と機能単位の完了条件

| 工程 | 対象と完了条件 |
|---|---|
| P1 | featureブランチをv0.20.0専用構成へ切替え、固定sourceからNative build・起動・基本接続を成立させる。 |
| P2 | 編集パラメーターをv0.20.0に送信し、操作結果をUIへ反映する。解釈はLightCraftに委ねる。 |
| P3 | Whole／Region／Before／After／Draft／Full、Crop／Straighten、スポイト等を接続し、必要なGeometryと要求世代・revisionに基づく表示・stale応答処理を確認する。 |
| P4 | v0.20.0で新規作成したRecipe／Historyの保存・復元、Undo／Redo／Jump／Resetと保存失敗時の扱いを確認する。 |
| P5 | 標準Export、Queue、Thumbnail、Immich登録とSTACK連携を確認し、原本保護と生成物の管理を維持する。 |
| P6 | 実RAW／JPEG、CPU／DX12で統合確認し、不要patchを整理する。cleanな固定upstreamへの適用・buildと実binaryのschema、応答種別、SHA-256、manifest／receiptの整合を確認して正式採用する。 |

完了は機能と影響範囲に応じた検証を基準とし、旧patchのhunk単位移植を要件としない。工程ごとのfocused testと必要なbuild・型チェックを行い、実機確認は自動テストと区別する。性能やメモリに具体的な異常があれば対象を絞って調査する。

### P1 実施記録（2026-11-10）

- manifestをv0.20.0／固定commitへ切替え、標準Whole描画の実結果からUIに必要なFrameを取得する [`0001-v0.20.0-whole-frame.patch`](../../../native/lightcraft/patches/0001-v0.20.0-whole-frame.patch) のみを適用する。14ファイル、追加187行・削除20行、SHA-256 `2e99310e237a9a9b94e0fb85f6f64ef24492401dc05eb7d9f44fe1c5fe31f9bd`。対象と順序はmanifestが正本。内部キャッシュ・実行詳細の公開は追加しない。
- `build.py`の固定commit・version・patch digest／targets・全source差分検証、部分・重複適用拒否、実binary probeとreceiptを維持し、P1の`wholeFrameContract: 1`を検査する。Backendのartifact認証とFrontendの表示identityも同じmanifestに揃えた。旧Before／Region等の能力はreceiptに記載しない。
- clean固定sourceへの適用と独立した`git apply --check`、Native focused test 1件、`cargo build --release --locked --no-default-features -p lightcraft-cli`を確認。生成EXEは `.tmp/lightcraft-0.20.0-p1/target-p1-baseline/release/lightcraft-cli.exe`、SHA-256 `c3a1b9eeb43894072e933399a7afeb23975708decd8115cf740697723e3db7cd`。隣接receiptとmanifest・patch・実binaryを`build.py --binary`で再検証した。
- 合成PNGを用いた実Native MCP検証で初期化、schema、写真読込、settings取得・変更、Whole After／Full PNG・photo ID・Frame寸法、存在しない写真へのエラーと正常終了を確認。実receiptで認証したBackend経由でも読込、露出変更、revision更新、Whole取得と終了を確認した。Backendのmanifest・receipt test 44件、Frame・HTTP test 9件、起動・通信test 82件、設定画面test 28件とFrontend production buildが成功。ビルド時には未使用upstream patch、CJK font未同梱およびFrontend bundleに関する警告が出た。
- DBや既存データは変更していない。実RAW／JPEG、UI実機操作、Before／Draft／Region、Crop／Straighten、WB、Recipe／History、Export／Immich、実DX12は未検証でありP2以降に残す。既存の旧patch・累積暫定patch・checkpointは保持した。

### P2 実施記録（2026-11-10）

- 既存UIからBackendの49数値コントロールとv0.20.0のNative定義を照合し、名前・settings上の保存先・最小／最大・刻み・既定値の一致を確認した。基本補正、WB温度／色かぶり、彩度、グレーディング、Effects／周辺光量、Detail／ノイズ除去、Opticsが対象。ポイントカーブは既存の`develop.curve`経路を使用する。設定値の変換やNative patchの追加は不要だった。
- P1の実EXEをreceiptで認証し、リポジトリ内JPEGのコピーをBackendから開いて49項目を連続変更・readbackした。ポイントカーブ変更、編集前後のWhole Full PNG変化、カーブ操作中の画像、無効な値／未対応コントロールの拒否、各種Reset・section切替・周辺光量style・Optics flagも確認した。元JPEGには変更を加えていない。実RAWでは検証していない。
- NativeのDraftが未接続の場合、カーブ操作中もWhole Fullを要求して実際の品質をFullとして返す。通常の編集中PreviewもFull応答とFrameを受け入れる。画像の世代・revision・カーブ操作IDとstale応答の既存管理は維持し、FullをDraftと偽装しない。
- Backendのコントロール・カーブ・カテゴリ操作86件、カーブ／Frame管理14件、カーブHTTP 2件、Whole HTTP 4件、Frontend関連326件が成功。Frontend型チェック・production build、実EXE／receipt／manifestの再検証も成功した。Frontend buildには大きなbundleと依存モジュールのdirectiveに関する警告がある。ブラウザ・実機操作は未実施。
- DB・Recipe形式・既存データおよびNative patch／manifest／receiptは変更していない。Before／Draft／Region、Crop／Straighten、WBスポイト、保存・History全体、Export／Immich、実RAW・DX12統合はP3以降の対象。

### P3 調査・部分検証（Crop接続前の履歴。現状は後続記録を参照）

P1のv0.20.0実EXEについて、Backendを経由したMCP能力確認ではWhole Frameのみ対応し、Before、Draft、Region、WB候補APIは未対応だった。以下の表・結果はCrop／Before／Draft実装前の記録であり、現在の状態は後続P3記録を参照する。

| 機能・GenzoRoomの要求 | v0.20.0側の機能と必要な接続 | 当時の状態 |
|---|---|---|
| Whole After／Full：画像・Frameとrevision | 標準`render_preview`とP1のFrame公開を使用 | 接続済み。JPEGで実Native経由の幾何操作後のWholeを確認 |
| Before：import基準と現在のCrop／orientation | Engineの`before_settings`／`render_job(..., before=true, ...)`は存在するが、現在のMCP描画にはBefore引数がない。画像種別と要求の対応を含む最小公開とBackend接続が必要 | 未接続 |
| Draft／Full：操作中と確定時の品質 | Engineの`RenderJob::draft()`は存在するがMCP描画に品質指定がない。実品質を明示する公開と旧Adaptive依存の整理が必要 | Draft未接続。P2のWhole Full fallbackは維持 |
| Region／Zoom／Pan：Full上のwindowと配置Geometry | Engineの`region_job`／`region_job_before`は存在するが、現MCPにはRegionの要求・応答がない。必要なwindow・Geometryのみを公開し、Backend／Frontendの旧診断必須条件を整理する必要がある | 未接続 |
| Crop／Straighten／Rotate／Flip：操作とCrop編集画像 | 標準の`crop.*`／`photo.*`はsettingsを変更できる。Engineは`apply_crop=false`を指定できるが現MCPにはCrop編集画像の公開がなく、画像と編集対象Geometryの対応を接続する必要がある | 操作と通常Wholeを実Nativeで確認。Crop編集Previewは未接続 |
| WBスポイト：表示位置から候補を取得して適用 | 標準`develop.wbPick`は設定を直接変更する。既存UIの候補取得・確認境界と座標対応に必要な接続を検討する必要がある | 未接続 |
| ポイントカーブターゲット：画像上の位置とinteraction | 標準`develop.targeted`と既存interaction経路を使用 | JPEGで値の更新とWhole Fullを確認。Crop／回転後の表示座標との対応は未検証 |

実Nativeを用いる追加のopt-in回帰では、JPEGのコピーでCrop設定、8ハンドル、アスペクト比、Straighten、Rotate、Flip、Reset、Whole Frame、古いrevisionの拒否、カーブターゲットのinteraction ID・sequenceとFull画像を確認した。Backendの関連実行は67件成功・1件失敗。既存の実Native／合成DNG統合テストはCrop編集中のPreviewで`raw_preview_unsupported`（HTTP 503）となり、単独実行でも再現した。FrontendのCrop関連80件、Region関連151件と型チェック・production buildは成功したが、これらは実NativeによるRegion接続やブラウザ操作の検証ではない。buildにはbundleサイズ等の警告がある。

P3は完了していない。Native patch・manifest・receipt・実EXE、既存データは変更していない。上記の未接続機能と、実RAW／JPEGのWindows画面操作、GPU動作・品質の目視確認が残る。利用者による実機確認は自動検証と別に行う。

### P3 Crop編集Previewの接続（2026-11-10、P3継続中）

- LightCraft標準の`render_job(..., apply_crop=false)`を呼ぶ最小の`crop_edit`指定を既存Whole APIへ追加し、描画結果と同じFrameを返す。GenzoRoomは現在revisionのNative settingsを確認し、未Crop画像・Frameを検証してCrop編集座標へ接続する。描画前後のsettings readbackと既存の要求世代・revision管理により、古い画像を採用しない。Draft非対応時はFullをFullとして返す。
- 既存managed patchを必要な接続だけ更新した。14ファイル、追加227行・削除20行、patch SHA-256 `ed202b5e817610c0c4b530767266dce89aa87de82f82a1c519d9175afe98d8be`。cleanな固定upstreamへの適用を確認し、実EXEを再buildした。EXE SHA-256は`9fa5280c8e30f41dd59f07ae3c078ff7c61a59395ecf480dd901d9511109a906`、receiptはWhole FrameとCrop編集契約を記録する。手順は[更新ガイド](UPDATE_GUIDE.md)を参照。
- Native focused test 2件、実Native／合成DNGのHTTP・一時DB統合を含むBackend関連121件、HTTP focused 6件、既存Whole／カーブ回帰14件、実Native／JPEG幾何回帰1件、Frontend関連276件とproduction buildが成功。以前のCrop編集PreviewのHTTP 503は同じ実Native統合テストで解消を確認した。実EXE／receipt／manifestおよび`git apply --check`も成功。Native buildにはCJK font未同梱等、Frontend buildにはbundleサイズ等の警告がある。
- P3全体は未完了。Before、Native Draft、Region、WBスポイトと、Crop／回転後のポイントカーブターゲット座標の統合は残る。実RAWとWindows画面での操作・GPU目視は未実施。既存データは変更していない。

### P3 Before／Draft 接続（2026-11-10、P3継続中）

- `render_preview`／`render_photo`にBeforeと品質指定を加え、標準`Session::render_job`／`RenderJob::draft()`へ渡す。Frameは同じ描画結果から取得し、応答に`kind`・実際の`quality`を付ける。v0.20.0の標準`beforeAfter.setBefore`はfingerprintを返さないため、BackendはBefore画像応答のfingerprintを検証して保存する。GenzoRoomのrevision・要求世代・interaction ID／sequence管理を維持し、MCP公開schemaにStageCache・GPU execution・内部allocation情報を含めない。
- managed patchは14ファイル、追加278行・削除20行。目的はWhole／Crop Frame、Before／After、Draft／Fullの最小接続。patch SHA-256は`63662dd63537f22e9fefb6d80adc5ebfcaf64cff592959a687ff27863e366813`。正式tag／commitはv0.20.0／`192ff72923c39e6623f2c7ff67ab3a119deb8071`を維持する。manifestのreceipt契約をWhole Frame、Crop編集、Before／After、Draft／Fullへ更新し、開発targetは`target-p3-preview`として既存P1／Crop EXEを保持する。実EXE SHA-256は`67736b54c357572831017a04ce69bf047f9d201c0f7b774f273ff79ab29d89b0`。
- fixed-upstream clean checkoutへの`git apply --check`と`build.py --apply`が成功。Native focused test 2件、実Native／JPEG Backend統合2件、Before／Whole Backend 17件、Preview HTTP 7件、artifact／receipt focused 21件が成功し、実EXEのMCP schema・settings・PNG／Frame・Before／After・Draft／Full・未知photo errorを確認した。実Nativeの応答比較はCPU設定で実行。実RAW／DNGはこの工程で自動検証していない。GUI・Windows画面・GPU実機操作は対象外。
- **P3全体は未完了。** 当時未接続だったRegion／Zoom／Panは後続の「P3 Region Preview接続」記録を参照する。WBスポイトは標準`develop.wbPick`が即時変更型で、既存UIの候補取得・確認境界を満たす読み取り専用APIとCrop／Rotate／Flip座標変換がない。ポイントカーブのターゲット位置はWhole／Crop／Rotate／Flip／Region／Zoom／Panの全行列で未確認。実RAW／DNG、Windows画面の表示品質・操作感、GPU動作も未確認。既存DB／Recipe／Historyデータは変更していない。

### P3 Region Preview接続（2026-11-10、Region自動接続完了）

- 既存のViewport／DPR／Zoom／Pan計算、180ms集約、2048px上限、Whole表示密度判定、Region overlay・stale fenceは変更せず、既存Region要求をLightCraft標準Engineの`region_job`／`region_job_before`へ接続した。Native MCPには標準Engineを呼ぶ最小`render_region_preview` bridgeを追加し、plan/render入力と実画像、Frameに必要なwindow・寸法・kind・実quality・geometry IDのみを返す。Beforeは標準`before_settings`から描画する。内部Render Plan、StageCache、GPU execution、allocation情報は公開しない。
- BackendはNativeへの要求を写真・kind・quality・geometry ID・表示window／出力サイズへ絞り、Nativeの応答からGenzoRoom所有のphoto・revision・request identityを切り離した。Region成功判定は要求対象、画像、window、Frame寸法・geometry等に限定し、旧StageCache／execution/source診断metadataへの依存を削除した。FrontendのZoom／Pan・座標計算に変更はない。
- managed patch `0001-v0.20.0-whole-frame.patch` は15ファイル、追加482行・削除19行、SHA-256 `cd256727bd9f40661f2e066e1db37fa47ed2c26ccc4ead083bb46b0b6fd3dde8`。対象にはMCP Region schemaを含む。manifestは`regionContract: 1`、`geometryDescriptorContract: 2`、開発target `target-p3-region`を記録する。固定upstreamはv0.20.0／`192ff72923c39e6623f2c7ff67ab3a119deb8071`のまま。clean固定sourceへのapplyと`prepare`検証を確認した。
- Release Nativeを`.tmp/lightcraft-0.20.0-p3/target-p3-region/release/lightcraft-cli.exe`へ生成し、実EXE MCP probeでschema、Whole設定、Before／After Region PNG、実Draft／Full、Geometry ID、windowとPNG寸法を確認した。EXE SHA-256は`cf287ae00f52c10ef795b37a6e87a656bd30675f5be3fc94d9b5ea8794c0c1df`。隣接receiptは固定commit、managed patch digest／targets、Whole Frame／Crop／BeforeAfter／Draft／Region／Geometry descriptor契約とSHAを記録し、`build.py --binary`で再確認した。Native Region test 1件（build内focused実行）、Backend Region／artifact／patch関連99件、Frontend Region API／planner／scheduler／delivery／overlay等190件が成功。receiptは`.tmp`の生成物で、Git管理しない。
- Backendから実Nativeへ接続するopt-in統合testでは、リポジトリ内JPEGを使いBefore Full、After Draft／Full、Region PNG／window・寸法、Crop／Rotate／Flip後のGeometry整合を確認した（1件成功、他のopt-inケース2件は今回未選択）。HTTP Region経路はfocused Backend testで別途確認した。実RAW/DNGのRegionは未検証。実機のZoom／Pan品質・応答性・GPU動作はユーザー確認待ちであり、CodexはGUI操作を行っていない。
- この工程でRegion／Zoom／Pan接続は完了。P3全体はWBスポイト接続とポイントカーブターゲットのGeometry組合せ確認が残る。Crop編集中の未Crop表示を保持し、UI操作・表示領域計算は変更しない。DB／Recipe／Historyデータ、旧patch、checkpointは変更・削除しない。

### P3最終工程：WBスポイト・ポイントカーブ座標統合（2026-11-10）

上記の「P3継続中」「未接続」「残る」は各工程時点の記録であり、本節の完了記録で置き換える。P3の統合対象は既存Whole／Crop編集／Before／Draft／Region接続に限る。

- Native標準`develop.wbPick`は設定を即時変更するため、Engine内の同じLightCraft `auto_wb` 計算を呼ぶ読み取り専用`develop.wbCandidate`とMCP `estimate_white_balance`（`wbContract:1`）を追加した。candidate取得はPhoto ID・active photo・入力座標を検証し、settingsを変更しない。応答は要求identityをechoし、既存Backendがsettings fingerprint、Photo、revision、Preview geometryとgenerationを再検証した後にのみ候補をHistory操作で適用する。キャンセルは候補適用を行わない。WB計算・画像処理はLightCraft所有。
- WBクリック点と`develop.targeted`の点は、Whole表示上の正規化座標から既存`rawTargetPoint`でCrop／Flip／Straightenを逆変換し、向きを反映したsource座標でLightCraftへ渡す。表示CSS座標からWhole bitmap座標への既存変換によりRegion overlay、DPR、Zoom／Pan位置を扱う。点ターゲットは従来どおり標準`develop.targeted`と既存interaction ID／sequence／Draft／History経路を使用する。曲線演算・WB推定をGenzoRoomへ追加していない。
- 自動検証は成功。Native Engine／MCP focused test 5件、receipt-verified実Nativeを使うJPEG統合4件、WB／artifact／patch／geometry focused Backend 100件、picker／Native Preview回帰106件が成功した。JPEG統合ではsettings不変の候補取得、既存History所有経路による確定適用、Whole／Crop／回転／反転、Before／After、Draft／Full、Region windowと応答整合を確認した。Frontend focused test 4件が成功（関連外217件をskip）し、TypeScript／production buildも成功した。実Native対象はリポジトリ内JPEGであり、RAWは未確認。Windows GUI操作・表示品質・応答性・GPU実行はユーザー確認待ち。
- Native managed patchの累計は17ファイル、追加626行・削除35行、SHA-256 `ca30ff958ff5fbbd04e8e50b31c7c01a6319b7864b49ef8e506c3f20acc5f2ab`。固定upstream `192ff72923c39e6623f2c7ff67ab3a119deb8071`のclean checkoutへ再適用できた。開発targetは`target-p3-wb`で、EXE SHA-256 `30fa30913ceca0f3083ea05d0ebce27fb5668c00b1e78f9d6c2365e43686aa04`。隣接receiptは`wbContract:1`を含み、`build.py --binary`によりmanifest／patch／EXE SHAとschema・settings不変・不正座標応答を再確認した。詳細は[更新ガイド](UPDATE_GUIDE.md)。
- **P3実装・自動検証完了。** Windows実機のRAW／JPEG表示品質、Crop／回転後のスポイト・ターゲット操作、応答性、GPU動作はユーザー確認待ちであり、CodexはGUI操作を行っていない。Recipe／History全体の復元整合性と旧Recipeの`raw_restore_mismatch`はP4で扱う。既存DB／Recipe実データは変更していない。

### P3後の実機回帰：allReset保存失敗（2026-11-10）

実機ログ`genzoroom-all-logs-20261110T112335Z.json`の11:23:19 UTCでは、History operate → allReset → Native readback検証失敗 → compound操作rollback → Recipe／History失敗の順であり、DB書込みより前に停止している。ログ自体には不一致settingsが含まれていない。固定v0.20.0実EXEと既存Pixel DNG素材で同じHTTP 502／`raw_operation_readback_mismatch`を修正前に再現し、不一致を`optics.lens_profile`（GenzoRoom期待false／Native実際true）に特定した。

LightCraft `develop.reset`は写真のimport lookへ戻す。`Photo::camera_defaults`はembedded lensを持つ写真の`lens_profile`をtrueにするため、全写真にfalseを要求する旧検証が誤りだった。実Native段階probeでは次の結果を確認した（写真・Recipe本文は記録しない）。

| 素材 | Reset前編集後 | develop.reset直後 | WB As Shot後 | disabled_sections再適用後 |
|---|---|---|---|---|
| Pixel DNG optics.lens_profile | true | true | true | true |
| JPEG／Pentax DNG optics.lens_profile | false | false | false | false |
| disabled_sections（全素材） | effects | 空 | 空 | effects |

WBはPixel DNGでasShot／5336／14／kelvin、Pentax DNGでasShot／4923／1／kelvin、JPEGでasShot／6500／0／legacy（Native wireはscale省略）。各段階で一致し、他のOptics値は既存期待値と一致した。GenzoRoomはNative import時のOptics全体を写真単位で保持し、allResetの完全一致検証に使用する。保持はRecipe／resident編集状態の復元前に行い、DBやRecipeへ新しいmetadataは書かない。個別・カテゴリReset、WB As Shot検証、disabled_sections保持、rollback／retryは維持する。Native patch／manifest／EXE／receiptの変更は不要。

実Native CPU設定でJPEG・Pixel DNG・Pentax DNGのHTTP回帰3件が成功。Optics flag／distortion、露出、RAW WBを変更した状態からのallReset、Native Optics／WB／disabled_sections、History確定、Recipe保存、同一saveId再実行、再open復元、再編集後の保存・復元を確認した。個別／カテゴリResetとrollback／retryを含む既存category回帰48件、Native接続／import・再選択／Optics History回帰93件も成功。Windows GUIの「すべてリセット」操作による再確認はユーザー確認待ち。旧Recipeの復元不一致やRecipe／History全体の監査はP4へ残す。

### P4-A：Recipe／History経路・互換性の監査（2026-11-11）

**P4-A時点（2026-11-11）の状態記録。** P4-Aでは調査のみで製品コード、Native patch／manifest／receipt／EXE、DB schemaとユーザーデータは変更していなかった。以下の監査結果と当時の設計を保持し、P4-Bの現行実装は後段へ分けて記録する。旧Recipeの一括移行は採用しない。

#### 現行経路と保証

以下はP4-A監査時点の状態記録であり、現行動作は後述のP4-B実装結果を参照する。

| 段階 | 現行経路・保証・制約 |
|---|---|
| Asset Open／Import | `windows_raw_api`のPOST documentsで認証・workspace／Assetを確認し、SourceCacheから原本コピーを取得。`LightCraftRawSession.open_raw`がNative Import／select／photo.inspect／settings readbackを行う。写真別Optics snapshotをRecipe復元前に確保する（43a5085）。Document公開前のsettings fingerprintをimport defaultsとして取得する。 |
| DB lookup | `raw_recipe_store.lookup_raw_recipe`はSQLite read transactionで現在の完全identityを優先し、なければ同Asset／content hash／engine名／settings schemaの旧version・commit行を新しい順に候補化する。現行版だけへの制限はない。破損したrow／receiptはabsence扱いにせずStoreUnavailableとする。 |
| 互換性・Native復元 | `restore_persisted_settings`はRecipeの型・サイズ・settings.version／process／WB等と、Asset／Source hash／engine名／schema=1を検証する。version・commitの一致は要求しない。`_restore`はdevelop.reset→develop.merge→getを既存operation lock内で実行し、`_settings_json`で正規化した完全settings文字列の一致を要求する。WB legacy省略、既存Grading／Optics／Curve defaults補完はあるが、nr_outliers省略は補完しない。 |
| Document公開／History読込 | `_restore_document`はlookupとhistory readの間もworkspace／cache／selection epoch／identityを確認する。旧tupleを復元しても現在tupleのRecipe revisionは0、Historyは現在tupleから読む。成功後だけDocument handle／token／generation／revisionを公開する。保存済み旧tupleのHistoryを現在tupleへ移行する処理はない。 |
| 編集・操作確定 | Frontend `useRawDocument`→controls／`RawRecipeSaveCoordinator`→HTTP controls／history。Nativeの設定解釈はLightCraft所有。Backend `_mutate`のrevision・owner確認とreadback成功後のみconfirmed settingsを更新する。Curve／Geometry／WBは既存のinteraction・sequence・候補／確定境界を利用する。Preview表示は保存成功の証明ではない。 |
| History／Recipe保存 | HTTP `_history`はDocument revision／settings fingerprint／expectedRecipeRevisionとsaveIdを検証。operateはNative操作→readback、Undo／Redo／Jumpは保存された選択snapshotのNative復元→readbackを経てsaveへ進む。SQLite `_save_history`のBEGIN IMMEDIATE内でRecipe、History baseline／steps／cursor、receiptを同時確定する。CAS競合・書込み失敗はrollback。NativeとSQLiteを跨ぐ単一transactionではない。 |
| 保存失敗／retry | Native失敗はDB saveへ進まない。compound Resetは復元readbackに成功した場合だけrollback済みとする。DB保存失敗ではNativeの変更が残る場合があり、pending saveと凍結したsettings／同saveIdの再試行で整合させる。既存receiptはimmutable ackとcurrentを区別し二重History確定を防ぐ。Frontendはowner、revision、fingerprint、nativeMatchesRecipe、ack／History cursorを検証する。未知の成否を成功扱いにしない。 |
| 閉じる／再Open | 保存フェンスを通してWorkspaceを破棄し、次回ImportからDB復元を繰り返す。Frontend regenerationは旧generationと異なること、保存fingerprint／Recipe revisionの一致を要求する。離脱時の未確定操作は既存guardの対象。 |

監査で既存保証を確認したが、全操作・全組合せを実Nativeで検証し終えたという意味ではない。WB候補確認／cancel、Curve／Geometryのoperation境界、Before／Afterと保存状態の独立性などの網羅的P4回帰はP4-Cで行う。

#### 暗室が開けなくなる位置と通知

`lookup_raw_recipe`の`engine_incompatible`／`source_mismatch`は`_restore_document`で例外となる。旧version／commitでもschemaが同じならNativeへ適用され、readback不一致は`raw_restore_mismatch`→`raw_recipe_restore_mismatch`となる。通信・timeout等はrestore_unknown／restore_failed等に分類される（元のdetailをすべてHTTP codeへ保持する実装ではない）。Document openのexceptで`_release()`し、Documentを公開しないため、初期値の編集・Previewも開始できない。

Frontendは通常のopen errorを表示する。`RawDocument`に非互換Recipe通知の型はなく、専用通知もない。既存の「Reset development edits」は`delete_raw_edits`でそのAssetの全tupleのRecipe／Historyとreceiptを削除する明示操作であり、旧Recipeを保持するP4復旧には流用できない。既存テストも「非互換でopen失敗」「旧versionでも復元」「旧Recipeを削除して復旧」を期待するため、P4-Bで期待を更新する必要がある。

#### 旧raw_restore_mismatchの実Native再現

固定v0.20.0 EXE（SHA-256 `30fa30913ceca0f3083ea05d0ebce27fb5668c00b1e78f9d6c2365e43686aa04`）をCPU設定で使用。既存fixture `develop-v0.18.json`は**v0.18.0**、`develop-v0.14.json`はv0.14.0のsettingsであり、当時の実機Recipeそのものではない。各fixtureを現行adapterの`_settings_json`で正規化し、原本コピーをImport→select→reset→merge→getして差分だけを調べた。

| 旧fixture | JPEG | Pixel DNG | Pentax DNG |
|---|---|---|---|
| v0.18.0 | 正規化後の差分なし | detail.nr_outliers：期待は省略／実際true | 同左 |
| v0.14.0 | 正規化後の差分なし | detail.nr_outliers：期待は省略／実際true | 同左 |

全6ケースでmerge自体は成功した。v0.20.0 `DevelopSettings::for_raw`はRemove Hot Pixels（`detail.nr_outliers`）をtrueにする。reset後のRAW設定へ旧settingsをpartial mergeすると、省略fieldはそのtrueを保持し、get_developもtrueを返す。旧snapshotにはfieldがないため完全一致比較に失敗する。JPEGのfalseはNativeの通常JSONで省略され、この差分がない。ここはLightCraftの公開settings表現・merge契約との不一致であり、WB計算や保存DBの失敗ではない。

実機で過去に失敗したRecipe本文・対応readbackは未採取なので、その失敗フィールドがnr_outliersだったとは断定しない。既存fixtureと実RAWで再現できた具体的原因として記録する。WB scale／mode、Crop／Orientation、Opticsなどにはこの6ケースで追加差分がなかった。先行allResetの`optics.lens_profile`問題とは区別し、43a5085の写真別Optics・WB As Shot・disabled_sections保持を維持する。P4-Aでは旧settingsへのfield追加や比較条件の緩和を行わない。

#### P4-Bの互換性・復旧設計（実装基準）

1. Native適用前の明示条件をengine名／version／固定upstream commit／settings schemaの現行tuple一致とする。別tupleは自動移行せず「互換性未承認」としてImport初期値で開く。将来、別tupleの互換性を承認する場合は実検証に基づく明示的な対応表に限定し、version文字列の大小やschema番号だけで推定しない。managed patch digestは現在Recipe identityに含まれないため、同tuple内の未知の失敗をエンジン更新扱いにして救済しない。
2. 互換性判定はSource一致・row／receipt整合の検証後に行う。source mismatch、識別不一致、破損settings、通信切断、timeout、revision競合、同tupleの未知readback mismatchは初期値fallbackへ変換しない。既存owner／generation／tokenフェンスとエラー／pending復旧を維持する。
3. 旧tupleをNativeへ適用せず、正常なImport snapshotでDocumentを公開し、簡潔な「以前の現像設定は現行エンジンと互換性がないため適用していません。新しい編集を開始できます」という通知状態をBackend DTO→rawApi→useRawDocument／暗室表示へ渡す。復元成功を意味する`restored`状態を使用しない。通知はstale Documentに持ち越さない。
4. 現在のFrontend saverは初期化時にsaveを呼び、Backend initializeは`_write_recipe`を実行する。このまま流用すると編集前のbaselineを新しい現行Recipeとして永続化してしまう。復旧Documentでは**一時History baselineと永続Historyの存在を区別**し、初期化／Preview／表示切替／無変更離脱でRecipeを書かない。既存`initialized`の意味を黙って変更せず、復旧中の明示状態と保存境界を両側へ接続する。
5. 最初の変更を含む確定時だけ、Import baselineとconfirmed Native settingsを既存append transactionへ渡して現在tupleのRecipe／Historyを作る。storeは`baseline_settings`付きの新規appendを既に扱えるが、HTTPは非initializeを未初期化状態で拒否するため、この復旧Documentに限るadmissionとFrontend saverの対応が必要。wbPick／Reset／Curve／Geometry等が最初の操作でも同じ境界を通す。無変更操作と未確定／cancelは保存理由にしない。保存完了まで通知・未保存状態を保持し、retryで二重確定しない。保存後の次回Openはcurrent tupleを通常復元する。

#### DB保持方法と影響範囲

`asset_raw_recipes`の主キーはAsset／Source hash／engine名／version／commit／schemaの6項目。History baseline／steps、Recipe／History receiptもこのidentityへ結び付く。**別tupleの旧Recipe／Historyをそのまま残し、現在tupleは新しい編集確定時のみ追加**する方法を採用候補とする。既存schemaで実現可能で、アーカイブtable・無制限のRecipe複製・openごとの世代生成は不要。Historyは既存200step上限を維持する。既存row／receiptの自動削除、DB schema変更、旧Historyの現在Historyへのコピーは行わない。

同一tuple内で未知の復元失敗を自動的に別世代へ退避する設計は採用しない。旧tupleが複数ある場合はcurrent優先、旧通知対象の選択は既存の更新日時・revision順と整合させる。Export／thumbnail／Galleryの最新row選択は現在`updated_at DESC, recipe_revision DESC`であるため、編集前にcurrent baselineを保存しないことも重要。P4-Bではこれらが旧設定の適用成功を誤表示しないか境界を確認するが、Export本体の統合はP5へ残す。将来の保存世代整理はユーザー明示操作の別課題とし、今回の復旧で増やすのは固定current tupleの1行だけにする。

#### P4-B／P4-Cの変更箇所・検証計画

| 工程 | 必要な変更／検証 |
|---|---|
| P4-B Backend | `raw_recipe_store.lookup_raw_recipe`の互換候補分類、`windows_raw_api._restore_document`の非互換初期値open・通知・一時baseline、History admission／first changed append、`restore_persisted_settings`の同じ互換条件。既存CAS／receipt／unknown recoveryを再利用する。 |
| P4-B Frontend | `rawApi`の通知／復旧状態の型と検証、`useRawDocument`の表示／ownerリセット、`rawRecipeSave`の初期化とfirst edit保存境界。編集開始前の自動保存防止、cancel／no-op／切替／再open、最初の操作がWB／Curve／Geometry／Resetの場合を検証する。 |
| P4-C | current tupleでJPEG／Pixel／Pentaxの保存・再Open、連続編集、Undo／Redo／Jump、個別／カテゴリ／allReset、WB候補・cancel、Curve、Crop／Straighten／Rotate／Flip、Before／After、Asset切替／Workspace再生成を実Native＋HTTP・Frontend focused testで確認。通信・timeout・stale owner／revision、SQLite failure、同saveId retry、未知readback不一致を非互換へ変換しないことを確認する。 |
| 保持の受入 | 新規編集前の旧Recipe／History／receipt全rowが不変、current tupleが未作成であることを一時DBで確認。最初の保存失敗時も旧row不変、保存成功後はcurrentだけ追加し、次回Openが通常復元となることを確認する。 |

#### P4-B実装結果（2026-11-11）

- 完全なcurrent identityが存在する場合だけ保存RecipeをNativeへ渡す。Sourceが一致する別tupleはRecipe／Historyの整合を検証した後`engine_incompatible`として扱い、NativeへmergeせずImport初期値でDocumentを公開する。source mismatch、壊れたrow／receipt、同tupleのrestore failureは従来どおりopen errorとなる。Native restore adapter自身もengine名／version／commit／schemaを再確認する。
- Backend DTOの`recipeRecoveryPending`をFrontendまで伝え、暗室Viewerへ旧設定を適用していない旨を表示する。復旧中はFrontend saverに空Historyの一時baselineを持たせ、open／Preview／表示切替／無変更saveでは永続化しない。
- 最初の変更確定は既存のHistory append transactionにImport baselineを渡す。Recipe、baseline、最初のstep、両receiptは既存CAS／SQLite transactionで一括作成し、成功後に通知を解除する。初期値のままのcommitはackなしの一時no-opとして返し、DB行を作らない。保存失敗では保留中の同一request／saveIdとImport baselineを保持して再試行し、receipt replayは二重確定しない。
- Gallery編集状態、Thumbnail、Export Queueはcurrent engine tupleだけを参照する。旧tupleだけが残っている間は未編集扱いとし、旧settingsをcurrent Export recipeとして公開しない。
- 旧tupleのRecipe、History、receiptは読み取り以外の変更をしない。schema・Native patch・manifest・実DBは変更していない。現行tupleのRecipe／Historyは初回の変更確定時だけ追加する。
- focused自動検証：Backend Recipe store／restore／Windows open／History API／Thumbnail lifecycle **252 passed**。旧Recipe非適用、Import初期値公開、初期値no-opで未作成、旧Recipe／History保持、初回保存失敗後の再Open、再試行、transaction後の応答不明からreceipt replay、current tuple再Openを一時SQLiteとfake Nativeで確認。Frontend rawApi／RawHistorySave／暗室Preview関連 **397 passed**。Frontend TypeScriptとproduction build成功（既存chunk size／`use client` warningsあり）。実Native・ユーザーWindows GUIによるP4-B受入は未実施。
- P4-CではJPEG／RAW実素材、WB／Curve／Geometryを含む全初回操作種別、通信切断・応答消失後のretry、保存cancel／再Open／Undo境界を引き続き確認する。P4-BはP4-Cを完了扱いにせず、P4全体も未完了。

#### P4-C検証記録（2026-11-12）

- 実Native v0.20.0（既存manifest／receipt検証済み`target-p3-wb` EXE）、隔離pytest DB、HTTP API、JPEGとPixel／Pentax DNGの一時コピーで`test_raw_reset_live.py`を実行し、**3素材すべて成功**。各素材でDocument open→複数カテゴリ編集の確定→workspace破棄→再Open→Native confirmed settings／Recipe一致とHistory cursorを確認した。RAWではImport `nr_outliers=true`、Detail category reset後のfalse相当readbackとRecipe再Open、続くallReset後のImport baseline true復帰を別々に確認した。Optics、WB、`disabled_sections`もallReset後の期待状態を維持した。JPEGにはRAW専用`nr_outliers`期待値を適用していない。
- focused Backend Recipe／History／Reset／WB／Curve／Geometry群は**487 passed、8 skipped**（未指定時にskipする実Native geometry testsを含む）。これらのFake Native／HTTPテストでUndo／Redo／Jump、分岐、cursor／receipt、P4-B非互換Recipe復旧、retry／CAS／保存失敗、WB候補確定・cancel、Curve draft／commit、Geometry操作境界を確認した。H1で追加したRAW Import trueを反映するようFake import初期値の期待値を更新し、simple crop validator用metadata fixtureにfull/after品質を明示した。製品コードの変更はない。
- Frontend Recipe／History／WB／Geometry／document focused testsは**9 files、475 passed**。`npm run build`（`tsc --noEmit`を含む）成功。既存bundle chunk sizeとReact Router `use client` directive warningsあり。
- 実Nativeで確認したのは上記複数カテゴリRecipe再Open、Detail/all Reset、RAWのH1 false省略復元、optics／WB／disabled sectionsの保存境界。WBスポイト候補・cancel／確定、Curve、Geometryの各編集から再Openまでの組合せ、Undo／Redo／JumpのNative再適用、通信断・timeout・DB保存失敗の実Native再現は未実施。これらはfocused Fake Native／HTTP／Frontend testで確認し、P4-C全操作の実Native受入を意味しない。Before／After、Previewの保存独立性も既存テスト範囲に限る。GUI／Computer Use、実画質確認、独立Exportは未実施（Export統合はP5）。
- テスト素材原本は読み取りのみで、一時コピーをNativeへ渡した。ユーザーDB／Immich資産、schema、Recipe identity、Native patch／EXEは変更していない。P4-Cで確認した履歴・保存契約を超える網羅試験は追加しておらず、P5には着手しない。

#### P4-Aの実施結果・未確認

- ソース監査に加え、上記旧fixture×素材6ケースを実Native MCPで実行した。結果はsettings差分だけを出力し、ユーザーRecipe全文や写真情報を診断ログへ追加していない。
- 既存Backend `test_raw_recipe_restore.py`／`test_raw_recipe_store.py`／`test_raw_history_store.py`は**251成功・1失敗**。失敗は`test_raw_reset_clears_recipe_history_reopens_defaults_and_saves_current_tuple`の704行目がversionを`0.18.1`に固定していることによる。単独でも同じassertで失敗し、現行値は`0.20.0`。P4-Aではテストを改変せず、P4-Cでこの旧期待値を更新する残件とする。成功テストには旧version許可、非互換open失敗、通信／timeout／readbackエラー、generation切替、CAS、SQLite rollback、receipt replay、History cursorと保存の整合を含む。
- 既存実Native HTTP `test_raw_reset_live.py`はJPEG／Pixel DNG／Pentax DNGの**3件成功**。43a5085のReset、WB／Optics／disabled_sections、History／Recipe保存、再open復元、再編集保存を再確認した。Frontend `rawRecipeSave.test.ts`は7件成功、暗室の既存open-error表示testは1件成功（関連外124件skip）。これは現行の非互換時error表示を確認したもので、新しい復旧UIの実装成功ではない。
- DBはpytest fixtureで隔離、実素材は取得fixture／一時コピーを使用。ユーザーの既存DB／Recipe、Immich資産への変更はない。GUI／Computer Use／ブラウザ操作、実機画質・応答性の確認は行っていない。文書のみの変更のため製品build／型チェックは再実行していない。
- 当時の実機Recipeそのものの原因確定、同tupleの全settings差分、非互換復旧と全操作の組合せは未確認。P4-B／P4-Cの実装・検証とユーザーWindows実機確認は後続であり、P4全体の完了とは扱わない。

## 既存成果とpatchの扱い

N1-1a〜cのFrame取得・受信・表示経路とN1-2のStageCache所有簡素化は再利用候補であり、そのままの採用を要求しない。N1-3はRevert済みであり、StageCache ON／OFFを公開接続契約として再導入しない。累積暫定patchとcheckpointは開発中の成果・履歴として保持し、正式採用時に必要な接続だけをmanaged patchへ整理する。旧成果の検証はその時点の範囲に限り、v0.20.0の完成を意味しない。

patchの目的、変更箇所、公開API、必要性、ファイル数と追加・削除行数を記録し、固定commitへの再現可能な適用とartifactの整合を確認する。次の更新では上流標準APIとの差分を再評価し、標準で実現可能になった独自APIのpatchは削除候補とする。既存の `build.py`、manifest、receipt方式は再現性のため維持する。詳細は[統合契約](LIGHTCRAFT_INTEGRATION_CONTRACT.md#native-patchと成果物の管理)と[更新ガイド](UPDATE_GUIDE.md)を参照する。

---

# 履歴：旧N1〜N6計画と実施記録

**以下は当時の記録であり、現在の実装指示ではない。** 後続の旧P0・P1〜P12も同様である。v0.18.1環境維持、旧契約やStageCache操作、metadata、工程順、完了条件に関する記述は当時の方針を示す。上記の正式改訂が優先する。

# LightCraft v0.20.0 統合計画 — 最小公開APIへの移行（旧版）

正式改訂：2026-11-10（Asia/Tokyo）。対象ブランチ：`feature/lightcraft-v020-port`。

**当時の改訂方針：** 旧方針「Native内部契約の全面移植」は廃止し、既存Engineを利用する最小公開APIへの移行を採用した。後半の旧P0計画・技術調査・P1〜P4-A1の検証記録は履歴として保持する。旧P1〜P12の工程順・完了条件・必須metadata・全hunk移植は引き継がなかった。

本改訂は計画書のみの変更であり、Native／Backend／Frontendの実装、patch、manifest、EXE、receiptを変更した記録ではない。N1の途中段階としてN1-1a／N1-1b／N1-1c／N1-2を実施。N1全体とN2以降は未完了。

## 改訂1. 目的・責任境界・不変条件

GenzoRoomはLightCraftに現像パラメーターを渡し、Preview画像と現像成果物を受け取る。LightCraftはdecode、現像アルゴリズム、GPU／CPU実行、StageCache、メモリ管理、画像生成、Exportを所有する。接続アダプターは既存Engineへの呼出し、通信、基本入力・応答・成果物の検証を担当する。

GenzoRoomはImmich連携、編集UI、要求の世代管理、Recipe／HistoryとUndo／Redo／Jump、STACK、Export Queue、生成fileの寿命と登録処理を所有する。Nativeのパラメーター解釈・現像計算をBackendへ複製しない。

- 通常PreviewとExportは上流標準APIを優先する。Before／Draft／Region／Crop表示／WB／レンズ情報は、上流Engineの機能を呼ぶ最小限のMCP公開APIとして維持する。
- **LightCraft更新前後の画質一致は要求しない。** 同じRecipeの色・階調・NR・シャープネスの変化を許容し、旧エンジン出力再現用の互換処理・比較テストは作らない。
- 保存した操作状態の復元、History、Preview操作、Thumbnail、Export、Immich登録の機能的整合性は維持する。DB migrationや旧Recipe一括書換えを前提にしない。
- RAW／JPEG等を受理するWindows Native経路を維持する。DockerのJPEG経路と独立DBは維持する。

| 区分 | 正式tag | 固定commit |
|---|---|---|
| 現行稼働 | v0.18.1 | `57024f072c234e0c6c850e0940a261790f976575` |
| 更新対象 | v0.20.0 | `192ff72923c39e6623f2c7ff67ab3a119deb8071` |

未リリースmainは採用対象にしない。候補の正式採用までは現行manifest、v0.18.1 EXE／receipt、利用者の実行環境を維持する。

## 改訂2. 最小公開APIと必要な結果

既存のtool名・command経路を優先し、並行する別名APIを増やさない。下表は機能契約であり、新しいwire field名を確定するschemaではない。実装時に既存Backendとの対応を確認し、必須fieldを省略したまま旧capabilityを名乗らない。

| 機能 | 公開する入力・結果 | 委譲先・制約 |
|---|---|---|
| 通常Whole Preview | photo、要求サイズ、画像、実寸法、要求に対応する識別情報 | 標準`render_photo`／`ui.render`／`Session::render_now`を優先。独自公開が必要な部分だけ補う |
| Before | Before指定、実際のkindと実効Before識別情報、画像 | `Session::before_settings`、`build_job`のBefore設定・profile・source選択を利用 |
| Draft／Full | 明示qualityと実適用品質 | `RenderJob::draft()`／標準Full。未対応値を拒否し、FullをDraftとして返さない |
| Region | plan／render、仮想Full寸法、window、実画像、有効領域・対応識別情報 | `region_job`／`region_job_before`等を利用。内部samplingをGenzoRoomで実装しない |
| Crop編集表示 | 未crop画像、編集対象cropと表示座標の対応 | `apply_crop=false`等の既存機能を利用。保存設定を表示のために変更しない |
| WB | AWB／スポイト候補、対象settings・表示frameとの対応 | 上流WB処理を利用。候補取得と候補適用を分離し、読取要求では編集状態を変えない |
| レンズ情報 | 写真metadata、実際の補正profile情報 | 読取queryのみ追加。補正計算・profile選択は上流が所有 |
| Export | 凍結settingsと原本、標準Export引数、生成file情報 | 上流Exportへ委譲。Queue、成果物検証、metadata付与、Immich登録はGenzoRoom |

共通検証は入力の基本型・範囲、operation success、photo／要求／世代の対応、quality／kind、実画像寸法、転送上限、原本保護、一時fileの後片付けを対象とする。settingsの未知fieldは保存・復元を妨げない範囲で保持する。現像内部の全field不変検証や内部cache keyの照合は必須にしない。

### Geometryの公開範囲

Frontendは次を使う。必要な情報を小さな描画結果として返し、GenzoRoomには内部Render Planの所有・再構成を持たせない。

| field・情報 | 用途 |
|---|---|
| `geometryId` | Whole／Region／Beforeの対応とstale表示拒否 |
| `nativeWidth`／`nativeHeight` | Fit／Zoom、要求密度、座標変換 |
| `aspect` | 実際の表示座標系の比率 |
| `fullWidth`／`fullHeight` | Whole bitmap／Region仮想Fullとの対応 |
| `window` | Region配置。Wholeはnull |
| Regionの`validRegion` | 有効部分の配置・採用 |
| Crop編集表示のcrop・座標対応 | 未crop画像に対する編集overlay |

根拠となる接続箇所は`frontend/src/rawWholePreview.ts`、`rawRegionOverlay.ts`、`rawCropDisplay.ts`、`useRawDocument.ts`。寸法だけからwarp・crop・samplingを推測して補完しない。必要ならNativeの実描画Frameから結果を取得する最小接点を残す。画像を生成した座標系との対応は必要だが、内部Plan全体のsidecar維持やGenzoRoomでの再planは要求しない。

geometry identityはtone変更と座標変更を区別し、解像度変更とWhole／Region配置を扱えることを完了条件とする。settings全体のhashへの置換は採用しない。具体的な生成方法は上流の実結果に基づき実装工程で確定する。

## 改訂3. StageCache・executionと既存成果の整理

### StageCache

GenzoRoom専用のCPU／GPU allocation列挙、capacity集計、固定budget、追加容量予約式、admission制御、`cpuBytes`／`gpuBytes`／`retainedBytes`／`budgetBytes`の必須応答を**削除対象**とする。N1-2で候補Nativeから独自計量・admissionを削除済み。v0.18.1の正式patchと旧Adaptive応答は未変更で、後続工程で接続を移行する。GenzoRoomはRSS／VRAM上限の代替保証を設けない。上流StageCacheの保持・再利用は維持し、必要な接続層はcache owner・解放・失敗後の再利用防止に限定する。

Cache OFFを維持する場合の意味は「接続層が中間StageCacheを保持しない」。上流source cache・GPU buffer poolを含む全cache停止とはしない。既存の固定budget設定・容量診断UIは整理対象。変更はNativeとBackend／Frontendを整合させて行う。

### GPU execution

GPU成功／未試行／CPU fallback詳細はPreview／Region画像成立の必須契約から外す。取得できる情報は任意の診断とし、欠落時は不明と表示する。GPU設定からGPU成功を推定しない。画像成功・品質・kind・geometry・要求対応の検証は維持する。

関連変更箇所：`backend/lightcraft_runtime.py`のcapability・引数、`lightcraft_raw.py`のmetadata／budget照合、`raw_region.py`のdiagnostics必須shape、`windows_raw_api.py`の応答、Frontendの`rawApi.ts`・Region契約・`rawDiagnostics.ts`・`RawPreviewDiagnostics.tsx`。詳細診断がない正常画像を拒否しない構成へ揃える。

### P1〜P4-A1成果の扱い

| 旧成果 | 新計画での扱い |
|---|---|
| P1 実描画Frameとの対応・試験 | UI座標に必要な最小接点と試験を再利用。全constructorのexecution sidecar等、診断専用変更は削除・縮小 |
| P2 descriptor・座標試験 | UIのWhole／Region対応と解像度間整合の試験を再利用。内部Plan表現への依存を縮小 |
| P3 allocation計量・admission | 削除対象。上流stage再利用、OFF解放、失敗後回復に必要な最小部分を抽出 |
| P4-A1 source保持 | source_identity追随とcold WB学習保護を再利用候補として保持。通常render／acceptで足りる経路にpreflightを義務付けない |
| P4-A2 | Before経路の調査完了・動作検証保留。実装完了とは扱わない |
| P4-B1 | 未実装。旧方針のgeometry／execution必須化を再開条件にしない |

現行正式patchはまだ変更していない。上記は将来候補patchの方針であり、既存成果を今回削除した意味ではない。既存の累積暫定patch・source snapshot・checkpointは追跡資料として保持する。

## 改訂4. 実装順序と機能単位の完了条件

新工程はN1〜N6とする。旧P工程のhunk数・完了扱いを新工程の進捗へ換算しない。工程を細分化するのは具体的な依存や検証上の阻害がある場合に限る。

| 工程 | 依存 | 変更範囲・動く機能 | 完了条件 |
|---|---|---|---|
| N1 通常Wholeの簡素化 | なし | 最小応答契約、標準Preview接続、独自admission・必須execution／容量metadataの整理をNativeとadapterへ一体反映 | After／Full画像を既存UIで表示。入力・PNG・要求対応・必要なgeometryを検証し、詳細診断なしでも正常採用。上流StageCache再利用を維持し、OFFで中間stageを解放。失敗後再描画可能 |
| N2 Before／Draft | N1 | 既存EngineのBefore設定・profile／source選択、Draft公開、表示要求接続 | Before／AfterとDraft／Fullを正しく区別。切替・同写真再選択・cold WB metadata・保存状態不変をfocused検証 |
| N3 Region | N1、比較表示はN2 | 既存Region API、最小geometry、Whole baseとRegion配置・要求管理 | Zoom／Pan、crop／rotate／flip、Before pair、stale拒否・失敗時Whole継続を確認。Full／window／PNG実寸と有効領域が整合 |
| N4 Crop／WB／レンズ情報 | N1〜N3の必要な座標契約 | 薄いCrop表示・WB候補・レンズqueryをUIへ接続 | Crop編集、AWB／スポイト、レンズ情報表示が動作し、読取でsettings／Historyを変更しない。適用操作は通常の保存経路へ合流 |
| N5 保存復元・Thumbnail・Immich Export | N2〜N4 | Recipe／History、nr_outliers省略の復元、標準Export・Queue・登録連携 | 保存／再open／Undo／Redo／Jump／Reset、Thumbnail、JPEG ExportとImmich登録・STACKの機能整合を確認。原本・save失敗保護を維持 |
| N6 候補生成・受入・正式採用 | N1〜N5 | 最小patchの正式化、候補build／receipt、identity切替 | 固定sourceからclean適用・build、実EXEのschema／SHA／receipt、対象回帰とCPU／DX12・利用者受入を確認後に正式manifestを採用 |

N1で取り除くのは独自計量と必須診断依存であり、cache再利用の性能機能を落として完了とはしない。通常renderの上流戻り値だけで必要なUI座標が得られない場合は、その結果取得に限る薄いNative追加を行う。N4の3機能は順次確認できるが、独立した多数の固定工程番号は設けない。

各工程は変更したcrate／adapter／UIのfocused testと必要なcompile・型チェックで確認する。N1〜N4はNative入口から画像・結果を取得するfocused統合確認を含める。全suiteを毎工程で要求しない。N6は既存結果を再利用し、未検証境界と以後の変更を補う。

### N1-1b 実施記録：Backend Whole Frame受信

N1-1aは標準`render_preview`／`render_photo`に任意`include_frame`を追加し、同一`render_now()`結果のFrameからmetadataを返す。N1-1bではBackendが`render_preview`のschemaで`include_frame: boolean`を独立検出し、対応Nativeへの通常Whole After／Full要求に指定する。従来のAdaptive capability判定は変更しない。Frameのみの応答はPNG・photo ID・Frameの型／範囲・画像寸法との一致を検証し、`stageCache`／`execution`詳細を要求しない。旧Nativeには従来経路を使う。要求世代・revision・stale拒否は既存経路を利用する。

MCP模擬のfocused testで正常PNG／Frame、Frame欠落・実寸不一致の拒否、Adaptive非対応とDraft拒否、stale応答の破棄を確認。旧Adaptiveのサイズ・execution検証等もfocused regressionで確認した。v0.20.0実EXE、Frontend表示、Before／Draft／Region、詳細cache整理は未検証・後続。N1-1bはBackend接続の限定完了でありN1全体の完了を意味しない。

### N1-1c 実施記録：Whole Frameの既存Frontend表示経路

N1-1bのFrameは`windows_raw_api.py::_preview_response`が既存の`X-Raw-Frame`へ渡し、photo／documentを束縛したgeometry IDと実寸法を返す。`rawApi.ts::rawPreview`は応答の世代・revision・serial・quality・frame shape・bitmap寸法を確認し、`useRawDocument.ts`はdecode後に所有状態を再確認して既存のURLとFrameを表示する。`ImageViewer.tsx`はNative寸法をFit／Zoomに使い、URLの生成・解放は既存管理を利用する。通常After／Fullの接続に製品コード変更は不要だった。

MCP模擬→Backend HTTPのfocused testで、Frameのみの応答、旧NativeのFrameなしfallback、同一serial／不一致revisionの拒否を確認。Frontend focused testで、cache／execution詳細なしのFull Frame受信・表示、寸法不一致や不正ID／古いreceiptの拒否、URL解放、既存stale view拒否とNative寸法によるFit／1:1を確認した。TypeScript型チェック成功。v0.20.0実EXE・receipt・runtime切替および実機表示は未検証。Frontend／Backend全suiteは実行していない。N1-1cはAfter／Full表示接続の限定確認であり、Before／Draft／Region、StageCache整理、N1全体の完了を意味しない。

### N1-2 実施記録：Native StageCache所有の簡素化

候補Nativeから独自CPU／GPU allocation列挙、容量集計、追加予約・固定budget・admissionと計量専用testを削除し、上流がもともと持つ`StageCache::bytes`／`GpuStages::bytes`／shared source計量を上流どおりに戻した。実描画FrameとGPU execution sidecarは保持した。旧数値metadataを固定値で埋める公開契約は追加していない。

`StagePool`は上流StageCacheのBefore／After各slotとsource identityの所有・解放だけを保持する。通常After Wholeは上流`render_job`へStageCacheを渡し、`run`／`Session::accept`を使用する。同一sourceの連続描画でownerを再利用し、source変更・内部OFF・失敗／不正Frame時に破棄する。GPU失敗時はstageを破棄して既存CPU fallbackを継続する。Cache OFFは内部所有層の動作であり、公開MCP操作としては未接続。

focused testはPipeline 2件、MCP 3件、GPU 2件の計7件成功・失敗0・skip 0。中間sample／linearの再利用、source変更、Before／After別owner、内部OFF、cacheなし描画、GPU失敗後のstage破棄とCPU fallback、既存Whole Frame応答を確認。GPU testは利用可能adapterで実行したがDX12 deviceの特定・実機受入ではない。`cargo check --locked --offline -p lightcraft-cli --no-default-features`、`cargo fmt --all -- --check`、固定upstreamへの`git apply --check`、Native source `git diff --check`は成功。GenzoRoom rootの`git diff --check`はpatch内の空のunified diff context行を末尾空白として報告する。適用後sourceの問題とは分けて扱う。

実RAW・実DX12、latency・RSS／VRAM・長時間挙動は未検証。Backend／Frontendおよび旧Adaptive契約、Before／Draft／Region公開、正式manifest／EXE／receiptは変更していない。N1全体の完了ではない。累積patch SHA-256: `50c1f98d35dba226966b1672e8d8aeae750bc869831fd3694ce18945b69a40b9`。checkpointは`.tmp/lightcraft-v020-state/N1-2/CHECKPOINT.md`。

## 改訂5. 性能の未検証事項と保護・成果物境界

**独自admission削除後のlatency・RSS／VRAM・長時間挙動は未測定。性能維持やメモリ削減は未検証である。** 既存受入のcache適用時速度は上流stage再利用の価値を示すが、独自allocation計量そのものの必要性を証明しない。

N1でcache再利用／OFFの操作応答を対象サイズで確認し、N3でWholeとRegionのcold／warm source取得・表示latencyを評価する。必要なRSS／VRAM観測はN6受入へ持ち越せるが、具体的なメモリ異常が出た場合は先に解消する。測定結果を理由なくGenzoRoom独自admissionの復活へ結び付けず、上流管理・保持寿命・公開呼出し方を先に調べる。旧画質比較は実施しない。

- `RAW_ADAPTIVE_PREVIEW_DESIGN.md`の操作速度・cache受入記録と、`RAW_REGION_PREVIEW_DESIGN.md`のcold Plan約660ms／再Plan約0.25ms等は過去条件の実測として参照する。新構成の保証値にはしない。
- Before profile切替、decoder／database lens identity変更、実RAW cold WB学習、保存状態不変、Geometry最小化後のWB／Crop座標はfocused検証が必要。
- nr_outliers省略falseとRAW import default trueの機能的不整合はN5で扱う。旧履歴§8は技術根拠として参照し、旧P9の工程番号や全チェックを自動継承しない。
- 作業はfeature branchと独立したNative作業source／targetで進め、未記録差分はReset／Cleanせず照合する。既存Native source差分、旧checkpoint、v0.18.1成果物を保護する。
- 工程ごとに許可された変更だけをCommitし、累積候補patchとGit管理外snapshot／checkpointに固定upstream・source hash・patch hash・検証結果・残件を記録する。Commit／Pushは各タスクの明示許可に従う。
- N6までruntimeが候補EXEを採用しない状態を維持する。途中sourceを正式`build.py`検証へ合わせるために検証を緩めたり、仮receiptを作ったりしない。
- N6で最終patchをclean sourceへ適用して候補を生成し、実EXEのschema・応答・SHA-256／receipt・manifest整合を検証する。正式採用と必要なFrontend identity更新は一体で行う。実環境の操作はそのタスクの許可範囲で行う。

---

# 履歴：旧P0計画・技術調査・実装検証記録

**以下は旧方針の履歴であり、今後の実装指示・完了基準ではない。** 「決定」「必須」「未着手」「P4以降」の記述は当時の状態を示す。実際の完了記録は末尾のP4-A1と既存checkpointを参照し、現在の方針・順序・完了条件は上記改訂1〜5を正本とする。旧本文は技術根拠と追跡性のため保持する。

# LightCraft v0.20.0 追随・実装分割計画（P0）

作成日：2026-11-09（Asia/Tokyo）。対象：GenzoRoom `main`から作成した`feature/lightcraft-v020-port`。状態：**P0の調査・設計完了。P1（GPU／CPU結果・execution）とP2（Geometry descriptor 2）は実装・focused検証済み。P3以降は未着手**。

## 1. 目的・対象バージョン・確定方針

現行managed Nativeを正式v0.20.0へ移すため、patchの各hunk、依存関係、途中検証、正式採用の境界を固定する。先行調査の機能一覧は再調査せず、移植に直接必要なソースと現行契約を確認した。

| 区分 | tag | upstream commit |
|---|---|---|
| 現行 | v0.18.1 | `57024f072c234e0c6c850e0940a261790f976575` |
| 更新対象 | v0.20.0 | `192ff72923c39e6623f2c7ff67ab3a119deb8071` |

[tag v0.18.1](https://api.github.com/repos/storytold/lightcraft/git/ref/tags/v0.18.1)と[tag v0.20.0](https://api.github.com/repos/storytold/lightcraft/git/ref/tags/v0.20.0)を照合した。以下のLCパスは更新対象commitのソースを指す。GitHubの三点比較は履歴分岐のmerge-baseを使うため、直接のタグ内容も参照する。未リリースmainの実装は採用根拠にしない。

**LightCraft更新前後での現像結果の一致は要求しない。** 同じRecipeでも色、階調、ノイズ処理、シャープネスが変わることを許容する。旧エンジンの画質再現を目的とする互換処理・比較テストは実装しない。一方、現在提供する操作、保存、History、Preview、Thumbnail、Exportが正常に動作し、保存した操作状態を現行エンジンへ復元できることは必須である。

Windows DesktopではRAW／JPEG等のNativeが受理する原本を同一Native経路へ渡す。DockerのJPEG WebGPU／CPU経路と独立DBは変更しない。Immich原本への書込み・削除、DB migration、Recipe事前一括変換、旧エンジン切替機構は本更新に含めない。

証拠区分：

- **事実**：固定ソース・現行patch・GenzoRoomコードで確認した内容。実行成功を意味しない。
- **決定**：本書で採用する実装方針・工程境界。
- **要実証**：将来のcompile、test、probe、利用者のWindows確認が必要な内容。

BM3D、Radius／Detail等の新UI、Process更新操作、カラーミキサーは追随後の別タスク。本計画はそれらを採用条件にしない。最新ProcessがV7であることとsettings schema `version=1`を混同しない。

## 2. 現行Native統合資産

### 2.1 正本と契約

| 資産 | 現行内容・役割 |
|---|---|
| [manifest](../../../native/lightcraft/manifest.json) | v0.18.1、上記commit、patch digest／targets、開発targetの正本 |
| [0002](../../../native/lightcraft/patches/0002-v0.18.1-native-contracts.patch) | **29ファイル・69 hunk**。SHA-256 `b2ce1c237f45adee62d09757d1ef544880f13f8a14114858b065f1ffa9dd2976` |
| [0003](../../../native/lightcraft/patches/0003-v0.18.1-lens-profile-info.patch) | `cmd/query.rs`の1 hunk。SHA-256 `61dc7e48a297bd3b8d7fd24873e692c5579d399bcc1cac1d6ba93f8b9fe5de0b` |
| 公開契約 | Before／Preview／Region／WB各1、Geometry descriptor 2、Crop edit 1、Lens profile info 1 |
| [build.py](../../../native/lightcraft/build.py) | `manifest()`、`source_state()`、`prepare()`、`probe()`、`receipt()`、`main()`がsourceから実EXEまでを検証 |
| [artifact adapter](../../../backend/lightcraft_artifact.py) | `managed_manifest()`、`resolve_managed_executable()`、`verified_artifact()` |
| [runtime](../../../backend/lightcraft_runtime.py) | `mcp --headless --compact`、世代管理、actual SHA／receipt／handshake／capability |
| [Frontend identity](../../../frontend/src/lightcraftEngine.ts) | `sync_identity.py`の生成物。手編集しない |
| 現行開発候補 | `.tmp/lightcraft-0.18.1/target-lens-profile-info/release/lightcraft-cli.exe`と隣接receipt。既存成果物を保持 |

現行候補の記録SHAは `1a2006fe083eeb15ff7dc7d054183cf5405c68cdca66c7a7bdc154d745871a3c`。P1開始時にファイルの存在・hashを読み取り確認する。稼働中processの採用EXEをこの配置だけから推測しない。

### 2.2 引き継ぐ文書

- [UPDATE_GUIDE](UPDATE_GUIDE.md)：更新時のfocused受入・managed buildの正本。
- [v0.18.1追随記録](LIGHTCRAFT_0_18_1_UPGRADE_REVIEW.md)：既存lens constraint／headless Lensfunと過去の受入。
- [architecture](../../architecture.md)：現行runtime、History、Crop、thumbnail、Exportの責任分界。
- [適応型Preview](RAW_ADAPTIVE_PREVIEW_DESIGN.md)、[Region](RAW_REGION_PREVIEW_DESIGN.md)、[descriptor調査](REGION_GEOMETRY_DESCRIPTOR_INVESTIGATION.md)：Whole／Region／実Planとcanonical geometry。
- [WB契約](WB_NATIVE_CONTRACT.md)、[Point Curve](RAW_POINT_CURVE_INTEGRATION.md)、[Detail調査](DETAIL_CONTROLS_INTEGRATION.md)：既存操作と未接続項目。
- [Lens profile info](RAW_LENS_PROFILE_INFO_CONTRACT.md)、[Lensfun管理](RAW_LENS_DATABASE_MANAGEMENT.md)：写真metadataと補正設定の分離。
- [Export](RAW_EXPORT_DESIGN.md)、[Windows共通現像](WINDOWS_COMMON_DEVELOPMENT_PIPELINE_DESIGN.md)：独立Sessionと平台別経路。

過去の文書内の全試験・benchmarkを更新の必須項目へ昇格させない。歴史的なtarget名・patch名より現行manifestとコードを優先する。本P0で既存研究本文やarchitectureは変更しない。

## 3. managed patchのhunk／契約別対応表

### 3.1 契約ID

| ID | 主責務 | 上流の対応箇所・移植方針 | 他責務との接続 |
|---|---|---|---|
| A1 | 実Plan sidecarと結果型 | `pipeline::Rendered`のgeometry／execution、CPU `render_impl`、GPU `Output::Image`、全constructor。画面用textureは別 | P1。D1／C2／D2が結果を利用 |
| A2 | GPU成功・fallback判定 | `gpu::try_render`→内部`try_render_mode`、`engine::media::develop_image`。上流の新しい実行条件とerror scopesを維持 | P1。B1の失敗時cache解放に接続 |
| B1 | cache容量・admission | `StageCache`、`GpuStages`、`StagePool`。sharpenを含む実allocationと追加予約を計量 | P3。C2／D2で使用 |
| C1 | Before／source所有 | `Session::build_job`／`before_settings`／`accept`、追加`accept_preview_source` | P4。D2のpreflightが再利用 |
| C2 | Whole公開契約・transport | `Headless::{render,adaptive_render,call}`、`tools::{helper_tools,render_photo,image_result,call_tool}`、Options | P4。D1／B1に依存 |
| D1 | descriptor 2 | `Frame::native_size_at`、`preview::frame_metadata`。実Planとoriginal gridから生成 | P2。C2／D2／E1／E2が使用 |
| D2 | Region 1 | `region::{tool,call,execute_inner}`、`Session::region_job[_before]`、`PixelWindow`／`plan` | P5。A1／B1／C1／D1に依存 |
| E0 | MCP補助依存 | workspace既存`sha2`とtestkitのMCP依存・lock差分のみ | P2でdescriptor helperと同時追加 |
| E1 | 読取専用WB 1 | `wb.rs`、`Frame::wb_source_point`、`auto::{auto_wb,wb_pick_sample}`、既存WB control接続 | P6。C2／D1を再利用 |
| E2 | Crop編集表示1 | Options／Headlessの`crop-edit`分岐、fingerprint、独立geometry。変更APIではない | P7。C2／D1／E1 fingerprintに依存 |
| F1 | レンズ情報1 | 0003の`query::specs`／`photo.lensProfileInfo` | P8。0002とはsource target非重複 |

### 3.2 0002全hunkの割当

`Hn@L`は**現行0002内の当該ファイルでn番目、旧側開始行L**。upstreamの将来行番号ではない。新規ファイルは全体1 hunkなので、関数別の分割先を§4・§6で指定する。同じhunkを複数工程に割り当てた場合も、未実装分を消失・完了扱いにしない。

| patch対象ファイル | 全hunk（旧側開始行 → 契約／工程） |
|---|---|
| `Cargo.lock` | `H1@3829` → E0/P2 |
| `crates/engine/src/cmd/develop.rs` | `H1@527` → E1/P6 |
| `crates/engine/src/media/quick.rs` | `H1@69` → A1/P1 |
| `crates/engine/src/media/render.rs` | `H1@227` → A1/P1<br>`H2@247` → A1/P1<br>`H3@316` → A1/P1<br>`H4@370` → A2/P1<br>`H5@384` → A2/P1 |
| `crates/engine/src/media/session.rs` | `H1@405` → C1/P4 |
| `crates/engine/src/media/tests.rs` | `H1@640` → A1・A2・C1/P1・P4 |
| `crates/engine/src/slide_title.rs` | `H1@358` → A1/P1 |
| `crates/gpu/src/lib.rs` | `H1@139` → A2/P1<br>`H2@452` → B1/P3<br>`H3@465` → B1/P3<br>`H4@560` → A2/P1<br>`H5@613` → B1/P3 |
| `crates/gpu/src/render.rs` | `H1@27` → B1/P3<br>`H2@84` → B1/P3<br>`H3@195` → B1/P3<br>`H4@481` → B1/P3<br>`H5@590` → A2/P1<br>`H6@803` → A1/P1<br>`H7@1290` → B1/P3 |
| `crates/gpu/tests/it/equivalence.rs` | `H1@1006` → A1/P1 |
| `crates/mcp/Cargo.toml` | `H1@13` → E0/P2 |
| `crates/mcp/src/backend.rs` | `H1@16` → C2・D2・E1・E2/P4・P5・P6・P7 |
| `crates/mcp/src/headless.rs` | `H1@14` → C2/P4<br>`H2@38` → C2/P4<br>`H3@55` → C2・E2/P4・P7<br>`H4@123` → C1・C2・D2・E1/P4・P5・P6<br>`H5@139` → C2・E2/P4・P7<br>`H6@157` → C2・D2・E1・E2/P4・P5・P6・P7<br>`H7@225` → C2/P4<br>`H8@236` → C1・C2・E2/P4・P7 |
| `crates/mcp/src/lib.rs` | `H1@19` → D1・B1・D2・E1/P2・P3・P5・P6 |
| `crates/mcp/src/preview.rs` | `H1@0` → D1・B1・C2・E2/P2・P3・P4・P7 |
| `crates/mcp/src/region.rs` | `H1@0` → D2/P5 |
| `crates/mcp/src/region/tests.rs` | `H1@0` → D2/P5 |
| `crates/mcp/src/region_contract.json` | `H1@0` → D2/P5 |
| `crates/mcp/src/region_fixtures.json` | `H1@0` → D2/P5 |
| `crates/mcp/src/region_schema.json` | `H1@0` → D2/P5 |
| `crates/mcp/src/tools.rs` | `H1@119` → C2・E2/P4・P7<br>`H2@218` → C2/P4<br>`H3@378` → D2・E1/P5・P6<br>`H4@415` → D2・E1/P5・P6<br>`H5@442` → D2・E1/P5・P6<br>`H6@485` → C2/P4<br>`H7@524` → C2/P4<br>`H8@540` → C2/P4<br>`H9@557` → C2/P4<br>`H10@609` → D2・E1/P5・P6<br>`H11@664` → C2・E2/P4・P7 |
| `crates/mcp/src/wb.rs` | `H1@0` → E1/P6 |
| `crates/mcp/src/wb/tests.rs` | `H1@0` → E1/P6 |
| `crates/mcp/tests/it/e2e.rs` | `H1@412` → C1・C2/P4 |
| `crates/pipeline/src/auto.rs` | `H1@144` → E1/P6<br>`H2@161` → E1/P6<br>`H3@175` → E1/P6 |
| `crates/pipeline/src/geometry.rs` | `H1@200` → D1/P2<br>`H2@242` → E1/P6<br>`H3@468` → E1/P6 |
| `crates/pipeline/src/lib.rs` | `H1@207` → A1/P1<br>`H2@311` → B1/P3<br>`H3@624` → A1/P1<br>`H4@650` → A1/P1 |
| `crates/pipeline/src/tests.rs` | `H1@11` → A1・B1/P1・P3<br>`H2@766` → E1/P6<br>`H3@856` → B1/P3 |
| `crates/ui-egui/src/render.rs` | `H1@1420` → A1/P1 |

### 3.3 0003

`crates/engine/src/cmd/query.rs H1@174` → F1／P8。上流`query::specs()`内、`develop.get`直前へ`photo.lensProfileInfo`を追加する。旧側文脈は一致するが、適用成功・compileは未実証。0002を先に適用する最終順序は維持する。

## 4. v0.20.0での変更点と移植方針

### A. GPU描画契約（A1／A2）

**事実**：`gpu/src/render.rs::render`は`Option<Output>`を返し、`Output::Image(Rendered)`と`Output::Display { frame, histogram }`を分離する。`gpu::try_render`は画像を取り出し、共通内部処理は`try_render_mode`へ移動した。`engine::media::RenderResult.frame`は画面用textureである。旧patchの`pipeline::Rendered.frame`は幾何Planであり、別の型・別の責任。

**決定**：

- CPU通常／deep、GPU U8／deepの画像生成成功点へ、実際に使ったPlanのgeometryを接続する。事後に別Planを作って実行証明にしない。
- cache画像やQuick／Title／on-screen用の空画像などのstand-inにはgeometry／executionを捏造せず`None`を使う。新しいconstructorも固定commit内で検索する。旧69 hunkだけの機械的移植で済ませない。
- 上流のview-cache hitは画像sidecarを持たない。現行headless用`render_job`は`view_cache=None`だが、P4／P5でcache済みstand-inへ短絡しない接続を確認する。契約が要求する実Planを失う場合はそのjobだけ通常描画へ進め、推測metadataで埋めない。
- executionはGPU error scopes、readback、出力確認、device失敗判定を通った**画像結果**へ付ける。DisplayをCPU画像成功へ変換しない。CPU fallback／未試行理由は既存の安全な固定metadataで返す。
- `develop_image`の旧LUT／Refine／proof gateを復活させない。v0.20.0の`handles`と共通GPU処理を利用する。
- OutOfMemory／DeviceLostの注入は既存試験のために追随し、driverの実OOMを起こす試験は要求しない。

**検証条件**：CPU／DX12画像にsidecarがあり実bitmap寸法と一致、stand-inはNone、GPU成功をscope failureで報告しない、失敗後CPUへ戻れる。**要実証**：新しいtexture／deep経路での全constructor整合と、GPU成功metadataを付ける最小位置。P1でcompileとfocused test、P11で実EXE確認。

### B. StageCache・メモリ計量（B1）

**事実**：`local::Planes.sharpen`とGPU `Planes.sharpen`が増加。CPU／GPUのCacheEntryには`colour_noise`、Planには`pre_nr_key`／`noise_key`がある。旧patchのscalar 5面＋RGB＝32 B/pixel予約は新しいsharpen面を含まない。

**決定**：

- `StageCache::{host_allocations,retained_bytes,cpu_admission_bytes}`と`GpuStages::{allocations,additional,bytes,host_source_bytes}`にsharpenを反映する。scalarを1面増やす基礎は36 B/pixelだが、これを総メモリ使用量や全scratch上限としない。
- hostはcapacity、deviceは実buffer size、同一allocationはCPU／GPU・Before／After間で重複排除。旧entryと新規確保の共存、pool余剰、shared source uploadの予約を維持する。
- `Cx::copy`と`shared_source_bytes`の実size利用hunkも落とさない。buffer容量と論理長の違いを現在のpool実装に照合する。
- `colour_noise`は所有データの実体に応じて計量する。固定長のnoise modelとpixel bufferを混同しない。NR keyとDraftのplane再利用を保持し、GenzoRoom独自のsettings hashへ置換しない。
- budget超過・overflow・情報不足では保持を断り、必要なcacheを解放して描画は継続する。失敗したGPU stageは再利用しない。budgetはcache保持・admissionの契約でありRSS／VRAM全体の保証ではない。

**検証条件**：sharpenあり、alias、Before／After二entry、CPU fallbackとのhost共有、radius／NR変更の置換、tiny budget／overflow、OFF解放。**要実証**：最小十分な追加予約式、色NRの実所有量、DX12上の実capacity。P3で責務別test、P4／P5で組合せ、P11で実EXEの上限拒否後継続確認。長時間memory benchmarkは含めない。

### C. Preview／Before（C1／C2）

**事実**：上流MCPの基本helperは維持されるが、GenzoRoom独自引数・metadataは未収録。`Session::build_job`はBeforeのsettingsに応じたprofile/sourceを選ぶ。さらに`source_key`は単純なcontent hashから`quick::source_identity(photo)`へ変わり、decoder／database lensの識別を含む。

**決定**：

- `accept_preview_source`の旧content-hash比較をそのまま移さず、上流`Session::accept`と同じsource identity境界へ合わせる。cold decodeのWB学習をpreflight保持で抑制しない。
- Beforeは上流`Session::before_settings`とimport defaultsを使い、Afterのprofile／補正を単純コピーしない。settings差に対応したsource選択を保つ。
- Options、StagePool、Headlessを一度に全移植しない。P2でmetadata、P3でpool、P4でWhole protocol、P7でCrop分岐を追加する。
- legacy品質省略、明示Draft／Full、Before kind／import fingerprint、geometry／executionを維持。unsupported remoteがAfterをBeforeとして返す経路は拒否する。
- TempPng cleanup、write-target原本保護、17 MiB PNG／16 KiB metadata／既存transport上限を維持し、画像やpathを診断へ追加しない。

**検証条件**：初回／既読source、同写真再選択、Before／After、Draft→Full、保存settings不変、Whole失敗後復帰、unknown quality／contract拒否。source identity試験はdatabase lens／ORF decoderの識別があるfixtureも対象。**要実証**：source保持とBeforeでの新規decodeの順序。P4でMCP focused e2e、P11でschemaと実render。

### D. Region／Geometry（D1／D2）

**事実**：`RenderRequest.exact_size`、`Frame::sample_windows`等が追加され、Exportは既に決めた最終寸法を再fitしない経路を使う。これはRegionのvirtual Full座標と同一ではない。lens constraintはv0.18.1にもあるため新規変更として巻き戻さない。

**決定**：

- descriptor 2のoriginal grid、nativeAspect、orientation、resolved crop、flip、座標を動かすwarpを維持する。gain-only vignettingや品質・解像度をgeometryへ混入させない。
- `native_size_at`と`frame_metadata`は同じ実Frameで整合させる。Thumb／Preview／Full間のrounded samplingをoriginal寸法と取り違えない。
- Region 1のPlan／render、kind／quality、Full寸法、window、work context、request identityを維持。Planとrenderの不一致をラベル変更で通さない。
- `exact_size`を一律trueにしない。上流のRegion jobとPlanで実際のFull寸法を確定し、必要な設定をfocused testで選ぶ。Exportの最終サイズ指定をRegionへ流用しない。
- C0 schema／contract／fixtureはFrontend正本と一致する内容で移す。Regionは2048軸・2,097,152 pixels・PNG9 MiB／line13 MiBの現行境界を維持する。
- Crop／Straighten／90度Rotate／Flipとlens constraintを含むWhole→Region→Wholeの配置を検証。新しいsamplingのアルゴリズム自体をGenzoRoomで証明しない。

**検証条件**：descriptorの解像度間安定、true geometry変更の識別、half-open window／境界clip、実PNGとFull/window echo、budget拒否。**要実証**：exact_sizeとの接続、source種別とroundingの組合せ。P2で純粋geometry、P5でRegion統合、P11でCPU／DX12 probe。

### E. WB・その他の独自契約（E0／E1／E2）

**事実**：上流の数値control定義、curve command、targeted commandは概ね維持される。読取専用`estimate_white_balance`とCrop編集表示の独自契約はない。`pipeline/auto.rs`のWB補助対象はv0.18.1と同一内容。

**決定**：

- P6で`auto_wb`の共通`WB_Y_FLOOR`／`wb_pick_sample`と既存`develop.wbPick`の接続を移す。AWB本体をGenzoRoomで別実装しない。
- `Frame::wb_source_point`は表示Wholeの実Planからwarp逆変換を使い、frame外・無効領域を拒否する。Region-local座標を受け付けない。
- `wb::{tool,fingerprint,valid,execute_inner}`はrequest／settings fingerprint／frame identityを照合し、source loadはaccept／source_nowの学習を呼ばない。候補だけ返し、選択・settings・import defaults・History・Undoを変更しない。
- fingerprintのV1 process省略、WB scale、数値表現は[WB契約](WB_NATIVE_CONTRACT.md)と既存Backendに合わせる。P9の比較用正規化をwire fingerprintへ流用しない。
- P7でCrop options、read-only branch、`cropEditContract:1`、requestId、settingsFingerprint、canonicalGeometry、bitmapSpaceを追加。normal Whole／Regionとは独立したgeometry IDを返し、Beforeと混用しない。
- E0はworkspace既存依存をMCPへ追加するだけとし、不要な依存更新をしない。

**検証条件**：AWB／pick候補、stale fingerprint／frame拒否、WB実行前後のsettings・History等不変、Crop-edit中の設定不変と独立geometry。**要実証**：新decode設定を含む読み取りの副作用、Crop bitmapの向きとsampling。P6／P7のNative testとprobeで確認。

### F. レンズ情報（F1）

**事実**：`photo.lensProfileInfo`は上流未収録。0003の挿入文脈、metadata、EmbeddedLens／LensSource、`lens_profiles::{database,profile_name}`は利用可能。`query.rs`には上流の`app.hotPixelLimit`が追加されている。

**決定**：既存read-only commandのshape・null／unknown／false区分、512-byte上限、profile component booleansを維持する。レンズ補正やprofile選択を再実装せず、database downloadも開始しない。Recipe／Historyには写真metadataを保存しない。上流のHot Pixel commandを消さない。

0002と0003は変更targetが重複しない。機能実装上は0003を単独compileできるが、GenzoRoom正式runtimeは両patchと全contractを要求する。最終順序は0002→0003、receiptの`lensProfileInfoContract:1`も維持する。**要実証**：実適用、metadataのfile／database／none／unknown応答。P8で実装、P11でschema／command probe。

## 5. P1以降の工程一覧・依存関係

以下は将来タスク。工程番号は本更新専用で、過去の同名Phaseとは別。

| 工程 | 主要責務 | 前提 | 工程の成果 |
|---|---|---|---|
| P1 | GPU／CPU描画結果とexecution（A1／A2） | P0 | sidecarを持つ画像経路がcompileし、stand-inとの区別をtest可能 |
| P2 | canonical geometry descriptor（D1／E0） | P1 | descriptor 2 helperとpure test |
| P3 | StageCache容量とadmission（B1） | P1・P2 | CPU／GPU allocation・StagePoolがfocused test可能 |
| P4 | Adaptive Whole／Beforeの公開接続（C1／C2） | P1〜P3 | Whole MCP schema／応答／cache動作 |
| P5 | Region 1の接続（D2） | P4 | Plan／render／window／budgetの独立tool |
| P6 | 読取専用WB 1（E1） | P4 | 候補推定と既存WB共通sample |
| P7 | Crop編集表示1（E2） | P5・P6 | 独立bitmap／geometry／read-only応答 |
| P8 | 写真別レンズ情報1（F1） | P1。通常はP7の次 | 0003相当command |
| P9 | GenzoRoomのnr_outliers設定復元 | P0。P1〜P8から独立して着手可 | 復元・比較・Detail Resetのfocused回帰 |
| P10 | 完全patch化・clean replay | P1〜P8 | candidate patch一式＋非active manifestの再現可能なsource |
| P11 | 正式手順による候補EXE検証 | P10 | managed build・全必須probe・候補receipt |
| P12 | 正式identity採用と統合回帰 | P9・P11 | active manifest／生成identityと候補を一致させ、関連機能確認 |
| 受入 | 利用者によるWindows操作確認 | P12 | 実機未確認点の解消。自動検証と区別 |

順序はP1→P2→P3→P4→P5→P6→P7→P8→P10→P11、P9→P12、P11→P12を基本とする。P5／P6はP4後に独立だが、本計画は単一担当の順次作業を想定する。各工程1回の作業で完了条件に到達しなければ「継続中」とし、検証不能な途中状態を合格と記録しない。

## 6. 各工程の変更範囲・完了条件

### P1：GPU結果・execution

- 作業開始時にGenzoRoomのstatus／manifest／現行候補のhash、作業用NativeのHEADを記録。専用sourceの準備は§9に従う。
- 対象：`pipeline/src/lib.rs::Rendered,render_impl`、`gpu/src/{lib,render}.rs::Output,try_render_mode,render`、`engine/src/media/{render,quick}.rs`、`slide_title.rs`、構造体constructorを持つ関連test。
- 旧hunk以外にも新規`Rendered`生成箇所、GPU deep return、`OnScreen`変換、失敗・cache stand-inを検索する。上流`RenderResult.frame`は保持する。
- 検証：`cargo check --locked -p lightcraft-cli --no-default-features`、対象crateの`cargo test --locked ... --no-run`でtest constructorもcompile。A1／A2に対応する既存・移植testだけ実行。
- 完了：新MCP契約をまだ公開せず、画像／textureの型とexecution経路がcompile・focused test合格。GPU不在のtest skipは記録しP11へ持ち越す。

### P2：geometry descriptor

- 対象：`Frame::native_size_at`、新`mcp/src/preview.rs::frame_metadata`、`mcp/src/lib.rs`のmodule登録、MCP Cargo／lockのE0。
- `preview.rs`の巨大な追加hunkからdescriptor部分だけを先に導入。Options／StagePool／Cropは後工程。計画の未実装一覧をcheckpointへ残す。
- 検証：MCP／pipelineのcompileと`genzoroom_geometry*`／`canonical_*`の該当pure test。original size、端数proxy、orientation／crop／flip／warp、tone-only変更を対象にする。
- 完了：descriptor 2のfieldsとgeometry識別が既存契約と整合。render schemaの公開はP4まで行わない。

### P3：cache所有量と予約

- 対象：`StageCache`のallocation／admission、`GpuStages`のallocation／additional、GPU集約helper、`preview.rs::{StagePool,CpuStageInput}`。
- test：`genzoroom_budget_tests`、`genzoroom_capacity_tests`、pipelineのCPU admission test、StagePoolのtwo-side／overflow／OFF解放。sharpen planeとNR key変化を既存testへ追加・更新する。
- 完了：budget判定を画像生成と独立して検証できる。描画が失敗しないtiny budget拒否、二重計上防止、旧新buffer共存を確認。GPU実行skipをCPU成功に読み替えない。

### P4：Whole／Before

- 対象：`Headless::{render,adaptive_render,call}`、`Session::accept_preview_source`、OptionsのWhole部分、Backendのpreview capability、toolsのWhole引数／metadata／PNG処理、MCP e2e。
- source identity比較をv0.20.0の関数へ合わせる。Before settings／profile選択、single decode→run→acceptの所有順序を保つ。
- `wb::fingerprint`参照を要するCrop分岐や未完成Region toolを先行公開しない。未対応capabilityはfalseのまま。
- 検証：Whole関連MCP e2e／Headless test、schemaのboolean Before・quality・cache引数、legacy metadata、remoteの誤label拒否。必要時だけ隔離targetにreceiptなし開発EXEをbuildし、明示pathの診断probeを使う。
- 完了：CPUのWhole Draft／Full・Before／After、cache OFF／ON／拒否後継続を検証可能。DX12は既存GPU testと最終probeで段階的に閉じる。

### P5：Region

- 対象：`region.rs`／tests／3つのJSON、Backend／Headless／toolsのRegion追加部分、`TempPng`のcrate内公開。
- toolは実装と同時に公開。`exact_size`と実Plan、window／contextの扱いは§4 Dに従う。
- 検証：`cargo test --locked -p lightcraft-mcp region -- --test-threads=1`を基本に、実際のtest名を確認して対象漏れを防ぐ。共有artifactをbytes比較。必要なら`region_probe.probe_region(binary, expected_version="0.20.0")`を隔離開発EXEへ直接実行。
- 完了：CPUでPlan→render、stale／geometry／quality／window不一致拒否、Whole→Region→WholeとBefore対応が通る。DX12未実証ならその残件を明記。

### P6：WB

- 対象：`auto.rs`3 hunk、`cmd/develop.rs::develop.wbPick`、`Frame::wb_source_point`と関連tests、`wb.rs`／tests、MCP dispatcher／capability。
- 検証：pipelineのWB関連testと`custom_white_balance_redevelops_in_camera_space`、MCP WB test。直接probeを行うなら`wb_probe.probe_wb`を明示path・expected versionで使用。
- 完了：auto／pick候補、fingerprint／request echo、Whole座標逆変換、settings・選択・History等の読取専用性。candidate適用は既存GenzoRoom側の処理に残す。

### P7：Crop編集表示

- 対象：Options／Headless／toolsのCrop部分と該当Headless test。P6のfingerprintを再利用し別定義を作らない。
- 検証：Crop-edit単体test、normal Wholeと異なるgeometry、Crop／angle／orientation／flip／lens warp、設定不変、stale fingerprintとBefore混用拒否。`crop_edit_probe.probe_crop_edit`を必要に応じて利用。
- 完了：既存契約1の応答が揃い、Whole／Region contractへCrop bitmapを混入させない。

### P8：レンズ情報

- 対象：0003の`cmd/query.rs::specs`だけを主とする。必要なNative testは同command／既存LensDb fixtureに限定。
- 検証：compile、未知metadataのnull／unknown shape、利用可能なfile／database／no-match fixture、読取専用性。`lens_profile_info_probe.probe_lens_profile_info`はunknown PNGの実command確認であり、実レンズ全種を検証したとはしない。
- 完了：0003相当契約と上流Hot Pixel commandが共存し、0002依存なしでも説明可能。最終receiptの採用はP11。

### P9：nr_outliers対応

§8を実装仕様とする。Native patchへ復元都合の現像処理を追加せず、GenzoRoomのsettings復元／比較／Resetを修正する。現行v0.18.1向けfixtureにも回帰がない形でfeature branch内に独立Commit可能にする。現行を壊す変更なら単独採用せず、P12と同時採用へ保留する。

### P10：完全patch生成・clean replay

- 前提：69 hunkの割当を全て消化し、新規constructor／追加所有量／source identityの追随を確認済み。
- 全source diffから `0002-v0.20-native-contracts.patch` と `0003-v0.20-lens-profile-info.patch` をfull-index・LFで生成。旧patchは保持する。工程別にpatchを増やして同じtargetを重複させない。
- 新規の管理sourceは対象pathだけ`git add --intent-to-add`し、実stageのdiffは空のまま全diffへ含める。source側の生成物やcheckpointをpatchへ含めない。0003の`query.rs`を0002へ重複収録せず、最終targetsは実diffから再取得する。
- `versions/0.20.0.json`を**候補用の非active manifest**として追加する。version／commit、実diffのtargets順、SHA、contracts、`developmentTargetDir: target-v020-managed`を記録。現在の`manifest.json`と生成identityはv0.18.1のまま。
- 完全な別clean v0.20.0 sourceで、0002→0003の`git apply --check`と適用を行う。`build.py --manifest ... --source ... --apply`により、最終source diffがpatch全体と一致することを検証する。
- 完了：余分・部分・重複適用を拒否し、共有JSONが正本と一致。ここで初めてcandidate patch一式をCommit可能。候補EXEの採用は意味しない。

### P11：managed候補EXE

- P10のclean replay sourceを用い、既存`build.py --manifest native/lightcraft/versions/0.20.0.json --source <source> --build`を実行する。
- このwrapperはMCP test、WB test、release CLI build、Whole／Region／WB／Crop／lens等のprobeをまとめて行う。以前のfocused検証を理由に内部gateを外さない。追加の無関係suiteや歴史的benchmarkは重ねない。
- 実EXE schema／kind／frame／settings、CPU／DX12、StageCache、全contract、実SHAを確認し、成功後だけ候補receiptを発行する。`--binary`で同じ候補manifestを指定してreceipt照合も確認。
- 完了：成功した実バイナリとsource tupleが結び付く。adapter不在skipは明示し、DX12未実証のままWindows全面受入済みにしない。
- `build.py`はsource変更後にも再照合する。test失敗後の手修正はP10へ戻してpatch再生成→clean replay。receiptを手作成・使い回ししない。

### P12：正式identityと統合回帰

- 前提：P9の関連testとP11のmanaged候補が合格。差分には必要なartifact／adapter testのみを含める。
- `manifest.json`へ候補tupleを正式採用し、`sync_identity.py`でFrontend identityを生成。候補manifestと正式manifestの全内容を一致させる。既存v0.18.1 manifest tupleは必要な履歴manifestへ保存し、旧EXE／receiptは変更しない。
- runtime変更はidentity更新だけでは足りない具体的なfailureがある場合に限定。fail-closedな検証を緩めない。
- `--binary`等で同じbytes・tupleに対する成功結果を再利用できる場合、同じprobeを別途重ねない。manifest同期／runtime artifact照合は別に確認する。
- 統合検証：既存RAW Viewer smoke、P9のRecipe／History／Reset／Thumbnail／Export、Windows共通経路の非RAW WB／操作fixture、artifact／runtime関連test。実EXEを使う確認は明示pathと隔離storage／test DBで行い、既存Desktopは再起動しない。
- Frontend identity／fixture変更があればTypeScript check・production buildと該当Frontend test。Backendは関連testのみ、Dockerの独立JPEG契約は既存policy fixtureで確認しDocker環境を操作しない。
- 完了：正式manifest、patch、生成identity、実EXE receiptが一致し、変更に関係する自動回帰が通る。失敗中は正式切替Commitを作らない。
- 利用者のWindows確認は後続受入としてPreview／Before／Region、Crop／WB／Curve／Detail、保存・Undo／Redo／Jump、Thumbnail、JPEG Exportを短く確認。ブラウザ自動操作・実Immich登録は明示の別指示なしに行わない。Immich登録境界はmock／transport fixtureで先に確認する。


## 7. ビルド・テスト・probeの実行境界

**本P0で下表の将来検証は実行しない。** P0はhunk網羅、依存関係、リンク、変更範囲、文書diffのみ確認する。

| 検証 | 最初に行う工程 | 最終的な証拠 | 境界・注意 |
|---|---|---|---|
| patch静的整合・hunk対応 | P0、各実装工程、P10 | 69 hunk＋0003＋新規upstream対応箇所の照合 | 文脈一致だけで適用成功とはしない |
| Rust compile／test compile | P1、その後変更した責務ごと | P11 managed build | `cargo check`だけでは`cfg(test)` constructorを検証できない |
| 責務別Rust test | P1〜P8 | 各工程checkpoint、P11 wrapper | 指定filterの実test件数を確認。0件成功を合格にしない |
| Native schema／command | P4 Whole、P5 Region、P6 WB、P7 Crop、P8 lens | P11実EXE | 未実装toolを公開しない |
| CPU render／契約 | P4 Whole、P5 Region、P6 WB、P7 Crop | P11全契約 | Native engine内部の現像式の再証明はしない |
| DX12 render／fallback | P1／P3のGPU test、以降必要な直接probe | P11実EXE | 不在skipとgpu_successを区別 |
| descriptor／Crop等のgeometry | P2、P5〜P7 | P11、P12 Viewer fixture | Full／Draftのbitmap画素差を不合格にしない |
| StageCache容量・上限 | P3、P4、P5 | P11実EXE | retained capacityとRSS／VRAMを区別 |
| `git apply --check` | P10 | clean v0.20.0への順次check成功 | このP0では実行しない |
| clean sourceへの全適用 | P10 | `prepare`の全diff照合 | 部分ソースへ正式buildをかけない |
| manifest／targets／patch SHA | P10候補、P12 active | source全diff＋manifest照合 | 同targetを複数patchへ分割しない |
| receipt／EXE identity | P11候補、P12 active | actual SHA・schema・全tuple | receiptは署名ではなくローカル照合記録 |
| nr_outliersのGenzoRoom回帰 | P9 | P12実Native統合 | 省略OFF／明示OFF／ONを区別 |
| Windows利用者操作 | P12後 | 利用者報告 | 自動testの成功と区別 |

### 7.1 途中工程の検証

P1〜P8は、専用source上で直接Cargoを実行する。出力は `--target-dir <専用source>/target-v020-port`、または同sourceのshellに限定した `CARGO_TARGET_DIR`で隔離する。製品環境変数・ユーザー設定は変更しない。責務ごとに対象crateを選び、CLI rootも`--no-default-features`で確認する。sourceの各工程終了時には、その時点の**累積差分**を`native/lightcraft/porting/v0.20.0/`の暫定patchへ反映し、固定commitからの差分と一致することを確認する。暫定patchはレビュー用の未完了成果物であり、active manifestや`native/lightcraft/patches/`に登録せず、`build.py`／managed buildへ渡さない。

MCP e2eが必要になったP4以降は、必要なときだけ同じ隔離targetに開発CLIをbuildする。これは**receiptなし・正式未承認の開発EXE**であり、既存runtimeへ渡さない。直接probeは既存moduleの関数へ明示EXE path／expected versionを渡す。一部probeはCPUとDX12を内部で実行するため、その内訳を記録し、既実行分を別commandで重複させない。

`build.py`の`source_state()`は固定HEAD、空の実stage、管理外untracked、正式managed patchに等しい全diffを要求する。未完成sourceや暫定patchがこの検査に通らないのは正しい。検証を緩める変更、仮receipt、contract version偽装で途中sourceを通す設計にしない。工程Commitへ入れるのはGenzoRoom側の暫定patchと必要な計画文書だけで、LightCraft source、checkpoint、Cargo生成物はGitへ入れない。

### 7.2 P10／P11の正式候補手順

以下は将来工程の例であり、P0では未実行。作業前に各pathが専用であることを確認する。

1. P10で固定sourceとの差分を完全patchへ変換し、P1〜P8の最終累積暫定patchと全source diffが一致することを確認する。正式patch／非activeの`versions/0.20.0.json`を同一候補として生成する。確認後、移行用暫定patchを正式化済みの重複成果物として同じP10変更で削除する。
2. 別clean sourceを用意し、HEAD＝対象commit、version、statusを確認する。
3. `build.py --manifest native/lightcraft/versions/0.20.0.json --source <clean-source> --apply`を使う。wrapperが0002→0003のcheck／適用と全diff検証を行う。手動で既に適用したsourceへ再度`--apply`しない。
4. P11で同じmanifest／sourceを指定して`--build`。成功した場合のみ隣接receiptが発行される。
5. `--binary <clean-source>/target-v020-managed/release/lightcraft-cli.exe`にも同じ`--manifest`を渡す。
6. P12でactive manifestを候補と同一内容へ更新し、runtime向けidentityを生成する。

P10で適用・source整合、P11でbinary、P12でGenzoRoom統合という別の合否を持つ。P11の既存wrapperには複数必須probeが含まれるが、全作業の検証をP11へ先送りするわけではない。wrapperを分解・改変してgateを省略しない。

probeが旧版の画素を期待して失敗した場合は、同一v0.20.0内の契約確認か旧版再現要求かを切り分ける。同一エンジン内のcache OFF／ON等の既存契約試験と、禁止する更新前後の画質一致試験は別である。必要なprobe修正だけを行い、LightCraftのNR／sharpen内部品質試験を新設しない。

Windows Backend testは `I:\code\genzoroom\.venv\Scripts\python.exe`（Python 3.14）、cwdは `I:\code\genzoroom\backend`。Permission denied時は同じEXE／引数を昇格で再実行する。全Backend／Frontend suiteは自動的に要求せず、focusedで閉じられない具体的リスクがある場合だけ理由を報告して拡大する。

## 8. nr_outliers対応工程（P9）

### 8.1 確認済みの意味

v0.20.0の`Detail.nr_outliers`はbool。一般defaultはfalse、`DevelopSettings::for_raw`はtrue、falseはNativeの保存JSONで省略される。`reset_section(Detail)`はfalseへ戻し、全ResetはRAWのimport defaultsを基準にする。`merged()`は未指定fieldを保持する。このため現行Reset→保存JSON mergeでは省略OFFがONのまま残り、復元後の一致確認が失敗する。

[settings](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/develop/src/settings.rs)、[defaults／merge／reset](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/develop/src/lib.rs)、[GenzoRoom session](../../../backend/lightcraft_raw.py)、[Native Export adapter](../../../backend/raw_export_artifact.py)が根拠。

### 8.2 実装する最小方針

- full snapshotを復元する送信payloadでは、`detail.nr_outliers`省略をfalseとして**明示してmerge**する。通常の部分更新で未指定の値までfalseにしない。
- readback比較に限り、省略falseと明示falseを同値にする。true、false、不正型を区別し、nullや文字列をfalseへ黙って変換しない。
- 共通helperは既存settings補助処理のある`backend/raw_controls.py`に置くことを第一案とする。復元payload作成と比較用viewは分け、同じ既定値の意味を共有する。新しい一般migration frameworkは作らない。
- **DB内のsettings／Recipe receipt／保存fingerprint／History snapshotは事前書換えしない。** 比較用viewをNative WB fingerprintやwire settings fingerprintの正本へ流用しない。新規保存は従来どおり実Nativeのconfirmed readbackを使う。
- Detail Reset確認はNativeがnr_outliersをOFFにする意味へ合わせる。全Resetは現行engineのimport defaultsを尊重する。操作状態の復元と最新defaultへのResetを混同しない。
- unknown Native fieldを削除せず、settings全項目の固定inventoryを増やさない。比較でこのfield以外の変更を無条件に無視しない。
- v0.18.1上のmain継続開発を壊さないことを既存fixtureで確認する。この移行期間の確認は旧画質再現用の互換機構を追加する意味ではない。

### 8.3 変更範囲と回帰

| 接続点 | 予定箇所 | 最小検証 |
|---|---|---|
| Recipe復元／renewal／rollback | `lightcraft_raw.py::_restore,restore_persisted_settings`、settings補助 | 省略OFF／明示OFF／ON→Reset→merge→readback、再open・renewal |
| Detail／全Reset | `apply_history_operation`、`raw_controls.py::DETAIL_RESET_DEFAULTS`周辺 | trueからDetail ResetでOFF、全ResetでNative初期状態、失敗rollback |
| Undo／Redo／Jump | 既存`windows_raw_api.py`→snapshot復元経路 | ONとOFFのsnapshotを跨ぐcursor移動、再読込、save conflict／retry維持 |
| Rendered Thumbnail | `raw_thumbnail_generator.py`の既存共通復元利用 | OFF Recipeで生成成功、独立Sessionと編集状態不変 |
| Native Export | `raw_export_artifact.py::_export_comparison_settings,export_raw_artifact` | full snapshot payloadと前後比較、ON／OFF、原本保護、JPEG生成 |
| 保存整合 | `raw_recipe_store.py`・History既存経路は原則維持 | 未変更DB receipt有効、unknown field保持、保存失敗時の既存動作 |

対象testは`test_raw_recipe_restore.py`、`test_raw_category_operations.py`、`test_raw_history_api.py`、`test_raw_thumbnail_generator.py`、`test_raw_export_artifact.py`等の該当caseに限定する。単一utilityだけでなく実際のReset→mergeを模したNative fixtureとAPI操作を接続する。

**P9完了条件**：省略OFF・明示OFF・ON、RAW default true・非RAW default falseを区別するfocused testが通り、既存の保存・失敗・retry境界を維持する。実v0.20.0での最終確認はP12に残す。DB schema／永続データversion／Frontend UIは変更しない。P9で不可避な追加変更が判明した場合は理由と範囲を記録し、無関係なsettings比較の全面書換えは行わない。

## 9. 既存環境保護・Commit境界

### 9.1 作業用sourceとcheckpoint

- P1〜P8および統合準備は`feature/lightcraft-v020-port`で行い、各工程Commitを同branchへPushする。P12で検証済みcandidateを正式採用した後に`main`へ統合する。現行v0.18.1のsource／EXE／receiptを変更・削除・上書きしない。
- P1で新しいGit管理外directory `.tmp/lightcraft-v020-port/`を用意する。既に存在する場合はHEAD／status／用途を確認し、再利用できなければ別名を使う。新規clean sourceの取得方法はそのタスクで確認し、既存checkoutへのFetch／Pull／Resetは行わない。正式tagのclean sourceが未入手ならそこで止め、取得だけを明確に扱う。
- 作業NativeのHEADは対象upstream commitに固定し、独自変更はdirty worktreeに保持する。Native側へ独自Commitを作らない。P10で固定upstreamとの差分を生成できる状態を保つ。
- P1〜P8は工程ごとに作業sourceの累積差分を`native/lightcraft/porting/v0.20.0/0002-v0.20-native-contracts.patch`へ再生成する。新しいupstream pathは`git add --intent-to-add`相当でdiff収録し、実stageは空に保つ。patchはfull-index・LFとし、各工程Commit／Pushへ含める。各工程終了時、Git管理外 `.tmp/lightcraft-v020-state/<工程>/`へ変更／新規sourceファイルのコピーと短い作業記録を保存する。記録はupstream commit、完了責務、後続へ残すhunk、全変更pathとSHA、暫定patch SHA、検証command／件数／skip／失敗を含める。EXEや画像をcheckpointへ複製し続けない。
- 次工程はsource status・upstream commit・暫定patch SHA・checkpoint記録を照合して再開する。記録にない変更や途中失敗があれば先に原因確認し、既存成果物をresetしない。暫定patchは未完了の後続契約を含まないため、常にレビュー用途のみとし、active manifest／正式patch directory／managed buildへ入れない。
- P10は別clean `.tmp/lightcraft-0.20.0/`を使用。候補EXEは `target-v020-managed`、初期開発EXEは `target-v020-port`に分ける。この配置は正式manifest更新後の既存runtime自動探索規則に合わせる。既存directoryがあれば上書きせず、別配置と明示EXE指定による採用手順を記録する。active manifest更新前はruntimeが候補を選べない状態を保つ。

### 9.2 Commit・統合できる単位

| 境界 | Commit方針 | active状態 |
|---|---|---|
| P0 | 本計画と研究READMEのリンクだけ | v0.18.1 |
| P1〜P8 | 工程ごとの累積暫定patchをfeature branchへCommit／Push可。作業source・checkpoint・生成物はGit管理外。暫定patchはactive manifest・正式patch・managed buildから隔離 | v0.18.1 |
| P9 | focused testを通り保存操作状態を復元するadapter＋testを同branchへCommit／Push可。DB migration／旧画質再現なし。実Native確認前の採用はしない | v0.18.1 |
| P10 | **完全**な新patch2本＋候補`versions/0.20.0.json`を一体Commit可。非active候補と明記 | v0.18.1 |
| P11 | binary／receiptはGitへ追加しない。検証結果は後続タスクで認められた記録先へ | v0.18.1 |
| P12 | 検証済みmanifest・生成identity・必要な履歴manifest／test変更を一体Commitし、検証後にfeature branchを`main`へ統合 | v0.20.0 |

上表は将来の整合したCommit単位を定義するもので、**本P0のCommit／Push許可を将来タスクへ拡張しない**。各実装タスクで明示されたGit操作範囲に従う。

P12の正式採用までは候補manifestをruntimeへ読み込ませず、ユーザー環境の`GENZOROOM_LIGHTCRAFT_EXE`も変更しない。候補EXEをoverrideしても現行manifestと一致せず拒否される状態を維持し、検証を迂回しない。採用後のDesktop起動・再起動は利用者が行う。旧EXEを残すことは自動fallback機構を導入する意味ではない。

作業開始時の無関係な変更は各工程でも保持する。本P0開始時は `desktop/permissions/autogenerated/desktop_lifecycle.toml`が変更表示されており、対象外として残す。Git addは許可pathを列挙し、`git add .`を使わない。

## 10. 未解決事項・実装時の確認事項

| 項目 | 現時点の判断 | 閉じる工程 |
|---|---|---|
| GPUの新Output／deep／on-screen constructor | 変更箇所は特定。旧hunk以外のcompile修正範囲は未確定 | P1 |
| sharpen・NRの正確な追加予約量 | 旧式が不足する事実は確認。36 B/pixelだけを最終保証としない | P3 |
| source identity追随 | 旧content-only比較の移植は不可。現上流のsource_identity利用方針 | P4 |
| Before profile選択・cold WB discovery | 新source選択を維持し、preflight cacheで学習を抑制しない | P4・P6 |
| Regionとexact_size | 一律trueは採用しない。実job／Plan／echoで選択を確定 | P5 |
| WB fingerprintとnr_outliers省略 | 比較用正規化とwire fingerprintを分離 | P6・P9 |
| Crop編集表示のsampling整合 | 既存contractを維持する方針。実bitmap確認が必要 | P7・P11 |
| 0003の適用／実レンズ応答 | 文脈一致だけ確認。必要性は継続 | P8・P11 |
| 省略OFFの復元・Detail Reset | 不整合をコード上で特定。修正成功は未実証 | P9・P12 |
| build.py既存probeの新設定への追随 | 失敗した場合のみ、現在のNative契約へfocused修正。gateは削除しない | P10・P11 |
| DX12 device／driverでの実動作 | source確認では確定できない | P11・利用者受入 |
| 既存Point Curve targetの座標 | v0.20.0固有のAPI破壊は未確認。既存fixtureで確認し、具体的異常時のみ切り分け | P12 |
| 最終patch targets／digest／EXE SHA | 実装・生成前なので未確定。旧値や予測値を採用しない | P10・P11 |

### 根拠ソース

いずれもv0.20.0固定commit。関数は§3・§4の名前で参照する。

- [GPU lib／実行判定](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/gpu/src/lib.rs)、[GPU render／Output／GpuStages](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/gpu/src/render.rs)
- [Pipeline結果型／Plan／StageCache](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/pipeline/src/lib.rs)、[geometry](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/pipeline/src/geometry.rs)、[local planes](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/pipeline/src/local.rs)
- [Engine render](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/media/render.rs)、[Session](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/media/session.rs)、[source identity](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/media/quick.rs)
- [Headless](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/mcp/src/headless.rs)、[MCP tools](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/mcp/src/tools.rs)
- [WB commands](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/cmd/develop.rs)、[WB engine helper](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/pipeline/src/auto.rs)、[query／Hot Pixel](https://github.com/storytold/lightcraft/blob/192ff72923c39e6623f2c7ff67ab3a119deb8071/crates/engine/src/cmd/query.rs)

### P0実施範囲と文書検証

P0は上記2タグのidentity、対象ソース、現行29ファイル69 hunk＋0003の割当、build.pyと関連研究・architectureの契約を確認した。patch適用・生成、Native／製品コード変更、build、test、バイナリ実行／差替え、receipt発行、稼働環境操作は行わない。

文書完成時にhunk表の69件対応、工程依存、ローカルリンク、許可2文書だけのstage、`git diff --check`／`git diff --cached --check`を確認する。これはP1以降の実装合格記録ではない。

## P4-A1 検証確定記録

P4をP4-A1（StagePool metadata・Preview source保持の既存実装確定）、P4-A2（Before設定・profile選択）、P4-A3（C1残条件のfocused検証）へ分割する。P4-A1はC1全体の完了ではない。各小工程は検証済み累積暫定patchと本計画をCommit／Pushする。P5以降の番号・方針は維持する。P4-BはWhole MCP公開接続と関連focused test、P4-Cは統合e2eと必要な修正を担当する。

P4-A1ではStagePoolの対象slot・budget・applied整合と、Session::accept_preview_sourceのsource_identity照合・WB学習前の保持抑制を確定した。Engineの既存focused test 1件、StagePool 2件が成功（失敗・skip 0）。Engine／MCP test compileとCLI checkはlocked/offline、target-v020-portで成功。formatの初回不一致は整形のみで修正し再確認した。clean固定sourceへapply --check／適用に成功し、全累積sourceは改行正規化後一致、適用後diff --check成功。Windows core.autocrlfによる物理改行差とpatch内context空白警告はソース不具合と区別する。

decoder／database lens変更時、実RAWのWB学習、実際の再選択とSettings／History／選択不変性のfixture実証は未完了。今回のEngine testは同一photoのjob再作成・Loaded再利用・stale identity拒否を確認した範囲であり、これら未実証条件を保証したとは扱わない。Before追加実装、MCP Whole接続、実EXE／DX12受入は後続へ残す。

累積patch SHA-256: `d8e7dbcceed4e7088f0fbc9d09c7c727bfc03e1ee70e5a916b566e9f2e14ccb6`。checkpoint: `.tmp/lightcraft-v020-state/P4-A1/CHECKPOINT.md`。
