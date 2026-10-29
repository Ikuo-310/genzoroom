# GenzoRoom 開発ノート

## RAW Export P4 API/CLI実機受入・原本取得修正（2026-10-29、画面受入保留）

基準1623483で公式Windows起動・実Immich接続とmanaged LightCraft v0.14.0の実EXE/receiptを確認。ユーザーのコンピューターUSE禁止指示後は画面操作を停止し、隔離DB＋実Native/実ImmichをAPI/CLIで検証した。実DNGがImmichExportSourceからJPEG専用get_asset_originalへ入りNative前に拒否されるHighを再現し、755636bでExport sourceだけRAW opt-inに修正。JPEG defaultのformat/MIME検査は保持、RAW MIME/拡張子allowlist・別Downloader/Runtime/Registrarは追加しない。

Pixel/Pentax初期・代表補正の完成JPEG、既存Preview APIとの寸法/画素統計、sRGB ICC/4:4:4/Orientation/標準EXIF/XMP、編集Manager不変を確認。混在JPEG/RAW/JPEG/RAWが1 Start・4件成功。Tag/Favorite ON/OFF・Stack作成/追加/member保持/COVERが成立。Album作成403のためユーザー指定既存Albumを使用し、生APIで既存83件保持・最新COVER 2件の85件、union継承と非COVER正規化を確認した。Stop、私有copyの不正入力での実Native失敗後JPEG継続、新RecipeでのRetry、隔離Runtimeの別プロセスrecoveryも成功。通常GUIホストのNative稼働中中断は行わない。原本ローカル/remote hashと兄弟file、ユーザーDBのRecipe/History/Queueは不変。検証Asset/生成JPEGとStack/COVER更新はImmichへ残す。

P1 Artifact約2.58～3.25秒/件、計測7子processのpeak working set約573～865MiB・exit=0、一時job空を確認。全体RSS/VRAMや常駐warm processは未計測、最適化なし。Backend関連607 passed・68 subtests、Frontend関連23 files/891 passed、TypeScript/production build（既存chunk size警告）・diff check成功。既知High/Medium未修正Findingなし。P1/Native/schema/Frontend/保存/Registrarの変更なし。

P4は実画面受入が未完了。Q保存drain、Arm/Undo等のブラウザー操作とViewer目視比較は自動テスト/Native APIの確認から区別する。実Album cleanup障害、他RAW形式、通常WindowsホストのNative/登録中recoveryも未確認。詳細はRAW_EXPORT_DESIGN §18。README/CHANGELOGは正式受入として更新しない。

## RAW Export P3 Frontend統合（2026-10-29）

Gallery/Stack/FilmstripのRAW Q除外を撤廃し、暗室active RAWでは既存prepareSaveの完了後に保存済みRAW status trueを確認してIDだけをenqueueする。保存中もdrainへ進み、失敗/default/unknownでは追加しない。inactive RAWは開き直さず、queued/failed解除は保存不要。旧JPEG-preview trueが既知RAWのfalseを隠す問題を修正し、回帰テストを追加した。Export管理はformat/is_raw・順序を既に維持するため、本体の変更なしで混在Start/Retryを利用する。Stop/Undo/選択/shortcut/polling/応答消失後のcanonical refreshは既存経路を維持した。

Frontend Export・Gallery/Stack・RAW保存・Reload・除外・shortcut・Undo・診断の関連テストを実行。既存fixtureのRAW status応答不足と遅延応答fixtureを補正して再実行し、残存失敗なし。TypeScript/production build成功（既存のchunk size警告あり）、Backend RAW runtime 14 tests成功、diff check成功。監査で保存中lockの過剰な拒否とlegacy status優先を修正し、既知High/Medium未修正Findingなし。Backend/P1/Native/SQLite/Immich登録処理は変更しない。実ブラウザー・Windows Native・実RAW・実Immichは未確認でP4に残す。README/CHANGELOGは正式受入前のため更新しない。

## RAW Export P2：既存Queue／Runtime接続（2026-10-29）

保存済みRAWを既存Queueへ投入し、Startのwriter transactionで完全Recipe/revisionを固定する処理を接続。RAW badgeと同じ保存row選択・verified baseline判定を共有する。既存processing_versionにraw-lightcraft-v1を識別子として用い、既存列にRAW Recipe全体を格納するためschema/migration追加なし。JPEGは旧payload・processing版・Retry timestamp identityを維持する。RAW Retryは最新保存状態を新Startで固定し新timestampを使用、recoveryは旧snapshotを現行engineで再実行してbytes差とremote重複を許容する。

既存serial workerでRAW→P1 export_raw_artifact、JPEG→既存Artifactへ分岐し、同じRegistrarへ渡す。Favorite/tag/Album/Stack/COVERを再実装せず、既存Registrarをmock HTTPで検証。P1の変更はoptional expected_content_hashをNative importと照合する入力保護のみ。現像・metadata・encoder処理の再設計なし。独立Managerがjob内で起動するため編集Managerのstartup順変更も不要。

完了監査では、RAW保存/Resetから共有Queueを削除すると旧JPEGの非干渉保証を壊すことを既存テストで検出し、保存APIは変更しない構成へ修正した。default/保存消失のRAW intentは残り、Start/Retryが再検証して拒否、既存操作で解除可能。Asset種別・Native source hash不一致は登録しない。監査後に残るHigh/Mediumの既知Findingなし（実機未検証は別）。横断527 passed・68 subtests、最終の入力照合/helper修正後は影響152 cases passed。Native非起動・隔離DB・mock transportの検証であり、実RAW/Windows/Immich、P3画面操作、P4受入は未実施。README/CHANGELOGは利用者導線が未接続のため更新しない。

## RAW Export P1監査Finding限定修正（2026-10-29）

F1/F2：Baseline・単一scan限定を撤廃。公開Artifact builderで一度marker/scan境界を解析し、byte範囲からEXIF/XMP APP1だけを置換する。Progressive・複数scan・scan間APP1を扱い、entropy/tableの内容検査や出力全体の再解析を省いた。memoryview＋最終joinにより圧縮画像の中間slice/list/bytearray複製を削減。F3：保存と同じcompact UTF-8 JSONと256KiB定数へ統一。F5：任意EXIF/XMP合計超過は警告付き最小metadataへfallback。F6：ICC説明文のsRGB文字列依存を撤廃し、readable RGBとICC保持を確認する。F4：100MP制限を撤廃し、JPEGは画像open/decodeせずSOF寸法を取得する。RAW512MiB・JPEG256MiB等の有限上限、独立Manager・timeout・readbackは維持した。

関連79 tests・既存68 subtests成功。Progressive/複数scanはPillow生成テスト素材でありLightCraft出力の実証ではない。Pixel/Pentax DNGの初期・代表4条件は既存寸法・撮影tag・scan/tables/ICC保持と復号を再確認、原本hash不変。ARW等実素材、実保存Recipe、WebView2受入、Immichは未確認。Native/Queue/Runtime/Frontend/保存形式に変更なし。以下の旧P1記録のBaseline/単一scan/100MPは現行制約ではない。

## RAW Export P1形式制限撤廃（2026-10-29）

P1初期実装のTIFF/DNG限定は暫定制約であり、現在の製品方針ではない。入力copyを`source.dng`固定から元basename・拡張子を安全に保持する方式へ変更。メタデータ読取を任意処理にし、TIFF標準tag抽出またはPillowのheader metadataを試行、取得不能時もGenzoRoom出力情報を付与してLightCraft現像を続ける。Nativeの形式対応を推測する拡張子リストは設けない。metadata警告とNative読込・処理失敗のcodeを分離した。

LightCraft `photo.inspect`はcatalog全体のserializeで、既存Export metadataはそのsubset。P0aで確認した時差・サブ秒精度・Make/GPS高度等の制約が残るため、不足tagの推測補完に使わない。追加Native patchなし。関連テスト61 passed・既存68 subtests passed。Pixel/Pentax DNGの初期・crop/rotationの4条件を隔離再生成し従来寸法を確認。ARW/PEF/NEF/CR2/CR3の実ファイル受入、実保存Recipe・Windows目視・Immichは未実施。以下のP1初回記録にある形式制限は過去時点の記録として扱う。

## RAW Export P1：LightCraft JPEG・Metadata・Artifact（2026-10-29）

`raw_export_artifact.py`に独立したRAW Artifact生成を追加。既存Managerのcloneで編集Sessionを保護し、完全settingsをreset/merge/readbackしてLightCraft既存MCP Exportで原寸JPEGを生成する。TIFF/DNG標準IFDから撮影情報を取得し既存allowlist validatorを利用、PillowでEXIF/XMLのみserializeした後にAPP1を置換する。画像scan・coding tables・ICCは保持し、JPEG再エンコードは行わない。Queue/Runtime/Frontend/Immichは未接続で、Native追加patch/buildも不要。

実RAWはPixel初期4064×3056／代表2445×3251、Pentax初期5472×3648／代表2918×4378で完成JPEGを生成。4:4:4・sRGB ICC・GenzoRoom識別と復号成功、P0aの同じDX12/source/settingsのNative JPEGに対するscan/tables/ICC一致を確認。PixelはMake/Model、offset/subsecond、GPS高度/日時を含む標準情報を保持。原本hashは不変、DB/Recipe/Historyへの書込経路はない。

関連テスト47 passed、既存68 subtests passed。通常sandboxではpytest一時directory作成が拒否されたため、同じrepository Python 3.14で権限付き再実行した。対象は新RAWテストと既存JPEG artifact/codecのみ。初期fixtureのrational型修正とmetadata adapterのIFD受渡し修正後の最終状態で全対象を再確認した。実保存Recipeはfixture未入手、WebView2利用者目視・Immichは未受入。metadata対応はclassic TIFF/DNGのみで、非TIFF RAW・複数scan JPEGは明示拒否する。詳細とP2契約は[RAW Export設計§13](research/lightcraft/RAW_EXPORT_DESIGN.md#13-p1実装検証結果2026-10-29)。

## RAW補正済みバッジ（2026-10-29）

RAWの完全なDevelopSettingsを写真固有のLightCraft import defaultsと比較し、既存のEditedBadgeをHomeとFilmstripで再利用した。HomeのRecent／Albums／Calendar／Favorites、既存のStack集約、補正済みフィルターへ状態を接続した。Historyだけが残る場合は補正済みにせず、カテゴリをOFFにしても初期値と異なる補正値が保持されていればバッジを残す。ALLリセットとRAW編集リセットでは初期状態へ戻り、バッジが消える。RAWのバッジは表示するがExport Queue操作は提供しない。Filmstripは編集中の現在設定を使い、Homeは保存済み状態を使う。

SQLite v8→v9で`asset_raw_recipes`へnullableなimport-defaults fingerprintを追加し、RecipeとHistoryの保存形式は変更していない。初期値が確認できない旧Recipeと状態取得失敗は未補正と断定しない。FilmstripでRAWをJPEG用`localStateFor()`からRAW判定へ接続し直し、RAW編集リセットの実行条件もJPEG専用`clipboardEnabled`から分離して既存`rawDocument.resetEdits()`へ通した。成功時はRAW RecipeとHistoryを消去して開き直し、失敗は既存エラー表示へ渡す。

ユーザーのWindows実機確認でRAWの補正済みバッジ表示、ALLリセット／RAW編集リセット後の消去、カテゴリOFFでも補正値が保持される場合のバッジ維持が確認された。JPEGの既存テスト失敗4件は、Color Gradingのリセット記号の文字化けと露光量入力の配列添字依存が原因で、記号を`↺`へ修正し入力欄を`data-adjustment-id="exposure"`で選択するテスト修正を行った。対象4テストはPASSし、Frontend typecheckも成功した。Frontend関連6ファイルの後続確認では206件成功、AnshitsuPageのSSRテスト1件が`window is not defined`で失敗したため、Frontend全体がPASSしたとは扱わない。

RAW status／Recipe／History／SQLite migrationのBackend対象5ファイル（`test_windows_raw_api.py`、`test_storage.py`、`test_raw_recipe_store.py`、`test_raw_history_store.py`、`test_edit_status.py`）は、権限制限外の実行で259件と15 subtestsが成功した。sandbox実行ではASGI／Storage関連のfixtureエラー後に処理が停止したが、同じ対象を権限制限外で完了できた。Backend全体テストの結果を示すものではない。

## Windows開発環境整備（2026-10-29）

Windows開発版の標準起動をリポジトリ直下の`run-dev.ps1`へ統一し、Windows PowerShell 5.1対応、Frontend／Desktopの差分ビルド、Backend Pythonソースの直接起動を行う。`desktop/assets`は再生成物としてGit管理から除外し、配布用`build.ps1`にもFrontend資産の同期を追加した。PowerShell 5.1実機でビルド・資産同期・Cargo差分ビルド・起動を確認した。旧LightCraft検証checkoutのCargo成果物を整理し、`.tmp`を76.64 GiB削減した。これらのWindows開発環境整備は利用者向けCHANGELOGの対象外とする。

## RAW Auto WB・WBスポイト実装完了（2026-10-27）

Windowsネイティブ版（Tauri WebView2）のRAW暗室へAuto White Balance（AW）とWBスポイトを統合した。Phase 1ではLightCraft v0.14.0の既存推定処理を利用する読み取り専用Native `estimate_white_balance`契約を追加し、Phase 2ではAWを既存RAW操作・History・Recipeへ接続した。Phase 3ではスポイトUI、ViewerのWhole正規化座標変換、Before／After・Region表示のgeometry所有権検証、Native Picker呼出しを接続した。Recipe形式、DB schema、NativeのBefore／Preview／Region契約とgeometry descriptorは変更していない。

Phase 3の初回GitHubレビューでは、Region表示中に再利用するBefore Wholeのdocument revisionが古いまま残り、正常な採取が拒否される可能性がMedium Findingとして指摘された。既存のWhole生成・保持・再利用とRegion照合を調査した結果、Before画像URLを再利用する場合も、source identity・`beforeKey`・geometry・render条件が一致した表示receiptは現在revisionへ更新され、Regionの所有権もそのreceiptに照合されるため、この経路では懸念が成立しないと確認した。旧receiptを保持したまま採取する回帰テストを含むfocused testを追加し、ソース本体の修正は不要と判定した。After側のstale revision、beforeKey変更、Asset切替、stale geometryも回帰確認した。最終レビューで未解決High／Medium／Low Findingはない。

関連CommitはPhase 1 `0d213decdf41a75c927c0a1421d374cc22bef497`、Phase 2 `eddb32666ec96f29e30e358e7b1f87a2c2217265`、Phase 3 `e5d169537d951c410ca53a7bcd2ad22bf2bd521a`、Phase 3レビュー回帰テスト `bdcbcb58db260b4a59849e0b2c1e694442d15336`。各実装段階ではNative／Backend契約とPickerのFocused test、Phase 2／3のHistory・Recipe・Preview連携テスト、Frontend関連test、TypeScript checkおよびproduction buildを実施した。Phase 3ではNative binary probeとmanaged artifactの検証も実施した。レビュー後は関連Frontend focused test 305件、所有権hook focused test 80件、TypeScript checkが成功した。既存production buildのchunk警告は別記録どおり残る。全suiteを実行したという記録ではない。

実機確認は自動検証と区別する。ユーザーから、Auto WBとWBスポイトの両方についてWindowsネイティブ版で実RAWを使った動作確認が完了し「動作OK」と報告された。個別の座標位置・被写体条件や全エラー経路など、報告に含まれない試験項目を個別PASSとは扱わない。JPEG暗室、Docker版RAW、RAW Exportへの機能追加を示すものではない。

## U3：LightCraft v0.14.0管理buildへ追随（2026-10-26）

正式tag commit `03c88c166c054c009db2a47187d59991f6232b85`を専用checkoutへ固定し、新managed patchでBefore/Preview/Region各1・canonical geometry descriptor 2を維持した。MCP schema、test移動、DecodedSource facts、StageCache計量を保持し、display-fit後のsidecarを無効化、engineのGPU proof gateと診断を同じ条件へ揃えた。旧v0.10 patch・manifest・C2 binary/receiptは保持し、archived manifestで旧sourceの再検証も通した。

当初のU3記録にある「永続Recipeはengine tuple完全一致」「旧Recipeは復元前に拒否」という方針は撤回した。永続RecipeはAsset ID・source content hash・LightCraft名・対応schema（現在1）が一致すればversion／commit差だけで拒否せず、現在engineへそのままrestoreを試す。成功後は通常編集でき、次回保存はv0.14 tupleで別行として保存する。Historyと同一実行snapshotのstrict ownershipは維持し、事前変換やmigration、将来版との完全画素互換は設けない。詳細は[U3結果§15.3](research/lightcraft/LIGHTCRAFT_0_14_UPGRADE_REVIEW.md#153-recipehistoryとversion表示)を参照。

SettingsはImmich情報の下に、実processのhandshake・EXE SHA・manifest・receiptが一致する場合だけ採用artifactのLightCraft版を表示する。Windows開発checkoutで環境変数が未指定ならmanifest versionに対応する`.tmp/lightcraft-<major.minor>` buildを探索し、receipt・SHA・contractが一致した場合だけ利用する。`GENZOROOM_LIGHTCRAFT_EXE`は旧版検証や別build向けの優先overrideであり、配布版は開発用`.tmp`を探索しない。未接続・不正metadata・古い応答では版を推測しない。

RAW編集に失敗してpersisted Recipeをrestoreできない場合は、暗室の「RAW編集をリセット」から同AssetのRAW RecipeとRAW Historyだけをtransactionで削除し、sessionを閉じて現行LightCraftの初期状態で開き直せる。元RAW・Immich写真・JPEG編集・Export情報などは対象外。version/commit差による拒否や旧Recipe migrationは行わず、schemaとsource identityが合えばbest-effort restoreし、読めないsettingsは実restore failureとして扱う。将来versionとの完全な画素互換は保証しない。

自動検証では実RAWのCPU/DX12、Whole 1024/1472/2048、Preview→Full、production planner経由Region、Before、Draft/Full、cache OFF/ON、正常終了が成功。CPU/DX12最大差はWhole/Region/Before各1 LSB、同engine cache Fullは一致。短い3回反復で明らかな遅化・異常なRSS増加は観測しなかった。大規模benchmark・旧版比較・C3 tuningは行っていない。数値・SHA・試験範囲・監査は[U3結果](research/lightcraft/LIGHTCRAFT_0_14_UPGRADE_REVIEW.md#15-u3実装検証結果2026-10-26)に記録する。

**U3自動受入PASS、Windowsの短い画面・画質確認待ち。** 新EXEを明示指定してBackendを再起動し、Settings、RAW Fit、100% Region、Pan、Before/After、数枚の画質をユーザーが確認する。今回agentによる実画面操作、NAS/Firefox受入、配布releaseは行っていない。

## RAW History全件表示と操作境界gesture（2026-10-26）

RAW Historyは初回取得で保持中のstepをすべて順序どおり表示する。20件単位のpagingとそのUI/API状態は廃止したが、保存上限`HISTORY_LIMIT = 200`は維持する。201件目以降の追加では従来どおり古いstepをrolling baselineへ畳み込み、直近200件を保持するため、全件表示は最大200件のHistory horizonを変更しない。

RAWのkeyboard／wheel編集は同じcontrolを続けて操作する間、無操作時間では分割せず1gestureとして保持する。別control、Undo／Redo／History Jump、control Reset、section Reset／Toggle、All Reset、pointer drag終了、数値入力Enter／blur、Viewer操作、Asset切替、暗室離脱、保存・終了境界で確定する。確定前のgesture粒度を操作境界単位にする変更であり、保存済みHistoryを後からmergeするものではない。既存のreceipt、handoff、retryとrolling baselineの保証は維持する。

## 工程C2：Windows実機受入完了（2026-10-25）

基準Commit `01a6c86832749e7b18857a1d165ca58b663277e1` の文書状態を更新。ユーザーのWindows実機受入報告により、**C2-B PASS、C2-C PASS、C2全体はWindows実機受入PASSとして完了**。C2-Bのowner/capability、中央・四隅・各edge、geometry/overlay配置、Zoom後再要求、Before/After、Whole base/fallback、およびC2-CのFit Whole-only（1472×1107、rho約1.01）、1:1 Full RAW Region（Whole 2048×1540、Region 1280×1536 / F 4064×3056、Whole density 0.5039、Region density 1）、Pan/Zoom/Zoom out、Before/After、明瞭な実効解像度向上を確認した。白抜け・位置ずれ・古いoverlay残留なし。実画面結果はユーザー報告であり、agentによる手動確認ではない。

C2-C途中のgeometry mismatchは診断履歴を保持し、Commit `01a6c86832749e7b18857a1d165ca58b663277e1`でcanonical Native aspectへ修正済み。descriptor contractは2、公開Before/Preview/Region contractは1。CPU/DX12実RAW Whole→plan→production planner→Region render、geometry fixture/regression、StageCache/Before、厳密契約検証の結果は[Region設計§16–17](research/lightcraft/RAW_REGION_PREVIEW_DESIGN.md#17-c2-windows実機受入完了2026-10-25)と[canonical regression記録](research/lightcraft/REGION_GEOMETRY_CANONICAL_REGRESSION.json)に記録。geometryIdは永続化されずmigration不要。

**C3は未着手**。rho threshold/hysteresis、context/prefetch、aggregation/quiet interval、F刻み、memory budget、latency、RSS/VRAM、stress、Dehaze差、部分coverage/tile、RAW Export、Scope、NR/sharpening等の現像品質改善はC3対象として未確定のまま維持する。実画面で見たカラーノイズやPixel JPEGとの差はC2 Region機構の不具合と扱わず、現像品質課題として残す。以下のC2途中記録にある「受入待ち」は各記録時点の履歴で、最終状態は本節を正本とする。ソース、test、managed patch、binary、設定値はこの文書更新では変更していない。

## C2-C geometry root fix：canonical Native aspect（2026-10-25）

基準`5f7a50d`の同一実RAW調査結果を受け、managed Native descriptor内部contractを2へ上げた。sampling bitmapの整数丸めが入るsourceAspectを、`Frame::native_size_at(original)`のorientation/crop適用後・未丸めNative寸法比であるnativeAspectへ分離した。source/original/crop/orientation/flip/実warpは保持し、旧IDとのaliasを作らない。Whole/Before/Region/StageCacheは同じ生成関数を使い、公開Preview/Region contractは1を維持する。geometryIdはsession/response/cacheとログの情報だけで、Recipe/History/SQLite/XMP/Export/Immich/saved sessionへの永続化はなくmigration不要。Backend fail-closedと`625a3fa`の診断を維持した。

比例／丸めPreviewの正式Native regression、真のgeometry変更とtone-only変更、Before、source cache所有、10種類のNative rect写像を確認した。Frontend356、Backend190、Native unit70＋E2E10成功、既存helper1 ignored。private実RAW harnessはCPU/DX12各2成功。同じRAW・Recipe120で新binaryのWhole1024/1472/2048→plan4064→実C0planner→Region renderもCPU/DX12成功し、actual F4064×3056、canonical ID/Native/W/valid/PNG一致、DX12 gpu_successを確認。cache ON/OFFでも同一Full PNG。TypeScript/build/差分検査成功、限定監査High0/Medium0。

新binaryは`.tmp/lightcraft-c2c-geometry-fix/target/release/lightcraft-cli.exe`、SHA-256 `7f4f76fd5c8989bf8439206c3bba778a753cf5e5b56359fb495cc14c4e914111`。managed patch digest `6d2e4113001aa8d9661ac706857191b2286ca420e4987be987bf55b6462609dc`。receiptと実C1 CPU/DX12 probeを照合済み。旧C1/診断用EXEは保持。既存chunk/font警告と調査NodeのExperimentalWarningあり。この記録時点ではC2-CのWindows受入待ちだった。Windows実機での最終PASSは本ノート冒頭と[設計§17](research/lightcraft/RAW_REGION_PREVIEW_DESIGN.md#17-c2-windows実機受入完了2026-10-25)に追記した。C3は未着手。README/CHANGELOGは変更しない。

## 工程C2-C：Pan/Zoom自動Region（2026-10-25）

ユーザー報告により `1e3fa0307e6b128faa6f91aef9763b889d516c0c` のC2-B Windows実機受入はPASS。owner/capability、中央／四隅／edge、geometry一致・位置ずれなし、Zoom後の手動再要求、Before/Afterを確認済み。

C2-Cは既存RawViewに実Pan／gestureを追加し、B1と共用する最新view集約からC0 density／planner、既存finite delivery／overlayへ接続した。Wholeを維持し、Native確認済みの独立Region Fで局所密度を高める。reuseはcanReuseRegionを通したmetadata rebindだけで、Native/decode/URL作成なし。Pan/ZoomとeditのDraft/Fullは既存hookへ統合し、History/saveは画像待ちにしない。

開始rho<0.85、解除rho≥0.95、集約／Zoom静止180ms、context16／prefetch64、F要求刻み256pxは全てC2-C provisional。Developer Diagnosticsで実bitmap/F・density/rho・可視rect・reuse/replanを確認でき、同じZoom/Pan位置でWhole-onlyと自動Regionを比較できる。製品値・性能・メモリ・Dehaze最終判定はC3へ残す。詳しい不変条件とWindows手順は[Region設計§15](research/lightcraft/RAW_REGION_PREVIEW_DESIGN.md#15-c2-b-windows受入passとc2-c自動region2026-10-25)。この実装記録時点ではWindows C2-C受入前だったためREADME/CHANGELOGは変更しなかった。

関連Frontendは重複除外454件、Backend契約／配送35件成功。最終修正の関連107件も成功。TypeScript、production build、Windows Cargo dev build、差分検査成功。既存chunk警告・incremental cache hard-link→copy警告は継続。限定監査High0／Medium0。実装完了時点ではagentによる実画面操作を行わず、C2-CのWindows受入と画質比較はユーザー確認待ちだった。最終受入結果は本ノート冒頭に記録。

## C2-B：Windows Region受入UI補助

`/developer` に「RAW Region Preview」tabを追加し、RAW ownerとはtargeted BroadcastChannelで接続する。中央・四隅・edgeの位置button、Before/After pair、解除、通常OFFの有効域枠、品質／geometry／画像サイズ／要求状態表示を実装。位置rectは現在Native frameの半分サイズから算出し、context=16 / prefetch=0はこのDeveloper Diagnosticsだけの試験値として固定した。Developer tab detach、photo離脱、Gallery復帰で診断Region・細枠・channelを回収する。通常暗室に開発ボタンを設けず、Pan/Zoom、threshold、C2-C、JPEG経路は変更していない。

関連7ファイル215件成功（UI位置・失敗表示・Before待機／pair操作、RAW lifecycle、C2-B overlay ownership／stale／pair試験）。TypeScript、Frontend production build、`git diff --check`成功。既存500 kB超chunk警告あり。Windows実画面受入はこれからユーザーが実施するため、Dehaze境界・1px alignment・実RAW/GPUは未確認。C2-Cには進まない。

## 工程C2-B：Region Viewer overlay統合（2026-10-25）

基準 `d12b38869538993700ea785e009d661e592256a5` からRAW専用Whole/Region共通wrapperと表示ownerを追加した。C0のNative placement／valid域clipを使い、decode後のowner/plan/request再確認、有限URL参照、Draft/Full整合交換、Before/After pairの両側採用、比較終了・mutation・photo離脱等の回収を接続した。今回、Windows受入をDeveloper DiagnosticsのRAW Region Preview tabから操作できるようにし、RAW hookへ対象限定BroadcastChannel、中央・四隅・edgeの固定Native半frame試験位置、Before比較、解除、任意の細境界枠を追加した。context=16 / prefetch=0は診断専用試験値で製品値ではない。通常暗室から自動要求せず、JPEG描画、Native/Backend、P1/History/save queueは維持する。

初回関連17ファイル526件は525成功／1失敗。JPEG永続化試験の既存range index依存の失敗は、基準Commitを隔離展開した環境でも再現したため範囲外課題として残す。最終修正後の関連9ファイル292件、TypeScript／production build、Windows hostのCargo dev buildは成功した。既存chunk警告とincremental cacheのhard-link→copy警告は残る。限定再監査の未解決High/Mediumは0。

C1 EXE実SHAとreceiptの各contract 1を確認し、Nativeを再buildしていない。実画面・実RAW/GPU・NAS/Firefoxは未確認。Dehaze最大3 LSB差を隠す処理は追加しない。[Region設計書§14](research/lightcraft/RAW_REGION_PREVIEW_DESIGN.md#14-c2-b実装完了region-viewer-overlay統合2026-10-25)に起動・明示request・比較・解除手順とC2-C開始条件を記録した。自動Pan/Zoom要求、threshold、製品context/prefetch／予算／性能値、Export、Scopeは未実装。通常利用者向け挙動はB1のためREADME/CHANGELOGは変更しない。

## 工程C1：Region Native/Backend完了（2026-10-25）

C0 `e0e442c`を基準に固定LC v0.10.0へ独立Region tool、実Plan preflight、厳密schema/PNG/work budget、共有StagePool、既存ownerへ合流するBackend adapterとoptional capabilityを追加した。C0共有fixtureをNativeでも利用し、旧B1実binaryのWhole継続を確認。C2のHTTP Region route、Viewer overlay、Pan要求は未接続。

Native MCP66成功/既存ignore1、e2e10成功、CPU/DX12実release probe・receipt/SHA照合成功。Backend関連は重複除外269成功、Frontend関連4ファイル136成功、型検査込みproduction build成功、Python構文/差分検査実施。既存chunk警告あり。全suite・ブラウザ・PyInstaller配布build・実RAW性能受入は未実施。限定監査High0/Medium0/Low1：Dehazeはupstream Whole proxyにより有効域最大3 LSB差があり、overlay受入はC2/C3で判断する。RSS/VRAM peakは未測定。詳細、binary SHA/patch digest、各容量とC2開始条件は[設計§12](research/lightcraft/RAW_REGION_PREVIEW_DESIGN.md#12-c1完了region-nativebackend2026-10-25)。C1で停止し、C2開始は次の明示依頼待ち。


## 工程C0：Region契約固定完了（2026-10-24）

基準`0b3e6127f217e1bdbb22e53ae28b093b84e8d635`。正本[Region設計§11](research/lightcraft/RAW_REGION_PREVIEW_DESIGN.md#11-c0完了region契約固定2026-10-24)へC0完了契約を追記。純planner、request/response・preflightのJSON Schemaと型、独立Region capabilityの純判定、実Whole密度不足率、content key／再利用／同geometry比較、running1＋latest pending1の有限descriptor状態遷移を追加した。通常Viewer/API/workerからは未接続。FはNative preflightで確定し、FrontendでLCのaspect丸めを推測しない。markerは`region_contract=1`、既存`preview_contract`やprotocol versionは変更しない。

context/prefetchはFull pixel、半開区間でvisible→margin/context→floor/ceil→grid snap→clamp。1px fixtureで除算先行による浮動小数誤差を検出し、座標×変換先寸法÷変換元寸法の順序へ固定した。表示域・配置・cap中央縮退・空context・非finite/overflowを検証。RAW向き/crop等は変換済みNative frameのfixtureでありNative変換画質の実証ではない。最大2048／2,097,152 pixels／PNG9 MiB／line13 MiBはC1初期budgetのまま、製品確定値にしない。

Frontend関連8ファイルの最終成功結果は合計300件（C0最終77＋変更のないB1関連223、重複再実行は加算しない）。Backendは新規未送信/Whole維持回帰＋既存adaptiveの2ファイル43件成功。初回Frontendはsandbox一時cache ENOENT、Backendはpytest一時dir作成失敗（10成功/33 setup error）であり、通常環境の指定Python3.14で切り分け・再実行して解消した。型検査込みproduction buildと`git diff --check`を実施。既存500 kB超chunk警告は残る。Browser動的確認、Windows Region実機、全suite、LightCraft patch変更・binary buildは未実施。

限定監査は座標/丸め・schemaと意味検証・capability fallback・identity/stale・bounded状態遷移・既存経路への影響を確認。未知modeとplan内のBefore key／Region geometry混在を拒否するguardを補強した。最終未解決High0／Medium0／Low0。C1へ進める契約状態だが、開始は次の明示依頼待ち。C1ではNative実Plan/source level/upright差、context/work拡張、CPU/DX12画素、転送/StagePool所有とreceiptを確認する。C2のoverlay/送信/owner接続、C3のthreshold/Pan間隔/先読み量/実機予算採用は未実装・未決定。C0で停止する。

## B1 Windows受入完了・限定UI cleanup・工程C設計（2026-10-24）

ユーザーのWindows実機受入によりB1（実装Commit `79e198ede4750f52fbed9116d6351597f62755c3`）を完了扱いとする。Pixel 7 Pro DNGのFit1472×1107、Draft4/4採用・discard0、同最終revision Full収束、DX12 gpu_success、cache512 MiB適用約205.3 MiBを確認。Native Draft69.7–73.8ms／Full74.9ms、終了→Full519.7ms。等倍では2048×1540、DX12 Full186.9ms、PNG約5.98 MiB。2048のcache budget拒否でも描画継続。最大化／panel／Zoom/Pan／Before/After／写真切替に目立つ違和感なし。詳細と証拠区分は[受入記録](research/lightcraft/RAW_ADAPTIVE_PREVIEW_DESIGN.md#b1-windows-acceptance)。RSS/VRAM peak、長時間、実driver OOM/device loss、全DPR網羅は未確認として残す。

正常RAW ready時の旧「最大1024px」常設説明を削除（日英ready文字列も削除）。loading、Preview失敗、編集失敗、Before状態とJPEG挙動は維持。RAW画面／Viewerの限定回帰2ファイル104件成功、型検査込みproduction buildと`git diff --check`成功。初回sandboxは一時cache ENOENTでsuiteをロードできず、通常環境で再実行した。追加loadingテストの期待値を既存の「Loading photo」に合わせて修正し最終104件成功。既存500 kB超chunk警告あり。Backend／Native製品コードは変更せず、そのテスト・binary buildは実施しない。ブラウザ動的確認は行っていない。

[工程C Region専用設計](research/lightcraft/RAW_REGION_PREVIEW_DESIGN.md)を新設。固定upstreamのwindow／source／margin／GPU/CPU／Beforeを再確認し、Whole base＋RAW専用overlay、明示4組intent、bounded plan、同geometry比較と別Region予算を推奨。C0契約固定→C1 Native/Backend→C2 Frontend統合→C3 Windows受入。閾値・Pan集約・margin・予算は検証候補。異geometry Beforeのmapping拡張は初期C対象外。Regionコード、管理patch追加、工程C用binary buildへ進まず停止する。

## A5実機受入完了とB1 Whole解像度（2026-10-24）

ユーザーのWindows実測でA5を完了。3990×3000 DNG／DX12／1024×770／512 MiBでgpu_success、cache適用139.86 MiB、Draft9/9採用・破棄0、終了→Full343.6 ms、Full／History revision11。GPU・CPU Full ON/OFF各6/6一致。GPU ColdのNative0.8秒に対するFrontend1.9〜2.0秒の差と、RSS/VRAM・長時間・実driver障害は未確認として残す。

B1はNative frame／bitmap／viewport／DPR／Zoomを分離し、表示需要を64px量子化・108%/75% hysteresis・180ms集約で選ぶ。gesture中はサイズ固定、終了Fullで再評価。長辺2048・2048²画素／PNG17 MiB／MCP line24 MiBを一体で適用し、Beforeも同じquality/サイズを要求して実寸・geometry一致を検査する。Panやサイズ変更でHistoryを作らず、P1/C4とJPEGを維持する。

Native管理patchはPNG envelopeだけ拡張。clean再適用、MCP59＋e2e10（既存helper1 ignored）、release build、実GPU1536/2048出力、CPU2048、Full一致・tiny拒否継続、高entropy PNG12,586,335 bytesの転送probeに成功。B1 EXE：`I:\code\genzoroom\.tmp\lightcraft-b1\target\release\lightcraft-cli.exe`、SHA：`09d38369d4cbe0274fe363862d139097be063845f65a31a2bbd3931d4357a02e`。旧P2版は保持する。

設計・安全予算・最終検証・Windows受入手順は[適応型設計§20](research/lightcraft/RAW_ADAPTIVE_PREVIEW_DESIGN.md#20-a5完了とb1whole-frame表示解像度2026-10-24)。この節はB1実装時点の記録。後続のWindows受入と工程C設計状況は冒頭の記録を参照。

Frontend関連11ファイル433件、Backend関連9ファイル271件の成功結果を得た。最終変更後の影響範囲再実行は重複集計しない。既存HTTP取消テストはcompile中の広い実行・単独実行で失敗し、compile終了後の単独再実行で成功した。Frontendの初回sandbox一時cache ENOENTは権限付き実行で解消。型検査込みproduction buildと`git diff --check`成功。警告・未実施項目は設計記録に分けて記載した。

## RAW適応型プレビュー A5-P2：DX12 capacityと予算判定（2026-10-24）

固定LC v0.10.0の管理patchを更新し、GPU保持をraw buffer capacity、CPU保持をVec capacityで計量する。全side・CPU/GPU entryのallocation identityで共有を重複除外し、描画後trimへ同じ計量を適用した。事前判定は実source／Plan、sampled/lin hit、最大plane、pool余剰25%、旧新共存、CPU fallback追加量から計算する。大shared sourceは別所有だがadmissionでは旧新容量を予約し、CPU P0と有限予算・working budgetを維持する。

render単位のgpu_success／cpu_not_tried／cpu_fallbackと固定reasonをMCP、構造化ログ、A4へ伝播した。GPU成功はreadback・error scope・出力検証後に確定する。hybridの全stage GPUを意味せず、旧metadata／旧A4 JSONも受け入れる。P1 scheduler、C4保存・History、JPEG、解像度は変更しない。

Native MCP 59＋e2e10成功（既存helper 1 ignored）、GPU unit2／Engine障害診断1／GPU既存統合4／CPU関連5成功。Backend4ファイル116、Frontend診断2ファイル30と型検査・build成功。clean固定upstreamへのpatch再適用、CLI release build、実binary DX12 1024px／512 MiB合成probe、Full ON/OFF一致、tiny拒否、receipt/SHA照合成功。既存craft-fonts／hard-link copy／Frontend chunk警告は残る。

新EXEは`I:\code\genzoroom\.tmp\lightcraft-a5-p2\target\release\lightcraft-cli.exe`。SHAは[DX12調査§12](research/lightcraft/RAW_DX12_STAGE_CACHE_RESEARCH.md#12-a5-p2実装結果2026-10-24)に記録。A2/P0 EXEは保持し、currentへの固定配置・安全な昇格機構は独立検証する後続作業とした。ユーザー実RAWでの適用・性能・RSS/VRAM・実driver OOM/device lossは未検証。P2で停止し工程B/Cへ進まない。

## RAW適応型プレビュー A5-P1：ドラッグ追従（2026-10-24）

HEAD `62798c2`からP1a＋P1bを実装。150ms trailing debounceを非延長timerと一latest patchへ変更し、通常gestureは一ACKでowner queueを解放する。ACK後の表示slotには最大約1050msの有限courtesyを設ける。gesture終了／保存flushは待たせず、既にbusyの処理も最終patchまでdrainしてから同queueのHistory保存へ進む。

DraftはdesiredではなくACK revisionを描画し、未送信入力だけでは失効させない。新mutation中、新ACK、別generation／Session／view、保存停止・終了・離脱では採用しない。decode後native照合と表示revision下限を維持し、bitmapからsettingsを更新しない。200／256、未知結果再送禁止、C4 receipt保証、JPEG経路は維持する。

模擬50ms入力×3秒ではmutation/render=10/40ms、10/250ms、300/40msでDraft採用17／8／6回、終了→Fullは50／260／490ms。旧trailingでは同期間の送信・採用機会は0。実RAW性能の結果ではない。固定サイズdebug `interaction.summary`でgesture別入力／送信／ACK／Draft要求・採用・棄却理由と遅延を確認できる。

通常StageCache ON／512MiBのnative引数回帰を追加し、Backend関連149件成功。Frontend関連回帰と型検査・buildの最終結果は[性能記録§11](research/lightcraft/RAW_PREVIEW_INTERACTION_PERFORMANCE.md#a5-p1)に記載する。周辺JPEG数値入力保存テスト1件はHEAD版でも同じ失敗を再現し、別件として残す。Windows実RAW／WebView、CPU/GPU・画質・RSS/VRAM・長時間操作はユーザー実機確認が必要。管理LC patch、解像度、工程B・C、History UIの別件は変更しない。

## RAW現像統合 Phase 1C-C3-D：同一RAWの安全なSession自動再生成（2026-10-22）

設計修正Commit `33a130eda91c868c8facc39ad80418b929b60d11`から限定実装した。Backendは既存mutation試行カウンターをdocument／settingsへ公開し、soft閾値200・hard上限256を使用する。復元・readback失敗を含む実試行数を使い、revisionやSlider入力数から推測しない。native adapterのhard limit・Session再生成・cache所有権／cleanup、SQLite schema v7は変更していない。

RAWパネルが既存Slider begin／commitをhookへ伝える。操作中に200へ達した場合は最新desiredだけを保持してnative送信をholdし、操作自体は切断しない。操作確定後に新規入力を停止し、最終patchのflush→readback→SQLite保存ack→旧workspace解放→同じRAWの再import／DB復元→新generation・recipe revision・全設定fingerprint一致→Preview確認の順に再開する。残56試行を最終flush・既存の有限な再同期等の余裕とし、連続入力でも200以降を無制限送信しない。DB未保存の初期baselineへ戻った場合も再生成前は確定設定を明示保存する。

保存失敗・結果不明では旧document／desired／同一saveIdの保存requestを保持して解放しない。release／cleanup失敗は旧workspace IDを残し、新規createを拒否する。restore／readback／Preview失敗ではDB行を保持し、初期値で成功扱いせずsession再試行を表示する。DELETE応答のみ失ったケースは再送conflictと既存capabilitiesのempty／cleanupPending=falseを確認した場合だけ進める。作成応答消失でopaque IDが得られない場合は所有を推定せず、既存lease等の回収待ちが残る。正常切替・終了は進行中の再生成を待ち、旧generation/tokenのSlider callbackとPreviewを採用しない。

検証：repo Python 3.14／cwd backend、関連8ファイル293件＋41 subtests成功。Fake LightCraftと一時SQLiteで複数世代の256試行超継続、200＋最終flush、完全readback保存復元、旧handle拒否、hard limit維持、RAW3枚の既存release／保存復元を確認した。Frontend関連10ファイル246件成功後、解放応答消失と再生成中の退出待機を追加し、変更範囲3ファイル43件も成功（最終関連範囲は計248件）。制御timer／gateで長いドラッグの300入力集約・最終201試行、保存／cleanup／復元失敗と再試行、再生成中新規編集拒否、旧Preview／callback・高速切替を検証した。JPEG保存・History・Queue・Viewer・Windows通常終了の関連回帰も成功。TypeScript check／production buildと`git diff --check`成功。既存500 kB超chunk警告あり。

C3-A〜Cの規約・JPEG編集保存は維持し、RAW3枚以上の切替は既存queue／lockを利用する。新しいresident manager、snapshot store、LRU、cache再実装、DB変更、C4／RAW Exportは追加していない。C3-CのWindows実機保存・復元成功は既存のユーザー確認として維持する。今回の実GPU・実Immich・Windows画面・長時間負荷／RSS・再生成待ち時間は未検証で、ユーザー実機確認へ残す。200はmemory危険値の実測結果ではなく、試行予算を保つための閾値である。全体suite・README／CHANGELOG変更は行っていない。

## RAW現像統合 Phase 1C-C3-C：Autosaveと写真切替・通常終了保存（2026-10-22）

C3-B完了Commit `5bdffb955103c2dcdfb36b9f20ca33c785c30915`から、Windows RAW recipe GET／PUTとFrontend保存ownerを接続した。Backendはworkspace／document／generation／tokenとnative revisionを確認し、LightCraftの完全な確定readbackだけを既存SQLite保存層へ渡す。Frontendは設定本文を送らず、native document revisionとSQLite recipe revisionを分け、完全設定のfingerprintでdirtyを判定する。schema v7、C3-Aのtransaction／saveId規約、C3-Bの原本・engine互換性検証と復元、C1 cleanup所有権は維持する。

RAW専用`RawRecipeSave`が確定readback後5秒でAutosaveし、保存中の追加編集は後続保存する。結果不明では同一revision・saveIdのimmutable requestを保持し、明示再試行で先にreplayする。Backendもactive documentの直近readbackを1件保持し、追加入力後でも元payloadで再送を照合する。recipe競合はDB metadataを再同期し、自動上書きせずユーザーの再試行を待つ。古いdocumentの応答やshutdown中のcommitは成功状態に採用しない。設定本文・原本path・PhotoId・資格情報はAPI／診断へ追加しない。

RAWからの写真切替、Gallery復帰、active写真のFilmstrip除外、Windows通常終了は、入力停止→最後のdesired flush→readback確定→保存ack→clean確認を待つ。失敗は写真・編集を保持して移動／終了を止め、再試行・stayを提供する。Gallery再入場・アプリ再起動時はSQLiteから復元し、訪問写真のmemory snapshot storeは追加しない。JPEG Autosave／History／現像済み判定／Export Queueは分離したまま。パネルに未保存・保存中・失敗と再試行を追加し、旧一時編集の注意書きをAutosave／終了保存の説明に更新した。

検証：repo Python 3.14／cwd backendの関連8ファイル291件＋41 subtests成功。RAW保存API／SQLite／復元／controls／native sessionと既存JPEG保存・Queueを確認した。Frontend関連10ファイル236件成功後、RAW→RAWの保存待機とGallery再入場復元を追加し、変更した暗室テスト13件も成功（最終関連範囲は計237件）。制御timer／gateでAutosave、追加入力、応答消失再送、競合、切替・終了失敗阻止と再試行、stale応答、DBからの新Backend復元を検証した。`npm run build`のTypeScript check・production build成功。既存500 kB超chunk警告あり。`git diff --check`成功。

C3-Dの多数RAW resident最適化・256試行上限前の世代再生成・長時間cache管理、C4のBefore／After・Reset・ON/OFF・History・Undo／Redo、RAW Exportは未実装。既存Session hard limitと写真切替時の再download／再importを維持する。ブラウザー強制離脱・OS異常終了時の最後の操作は保証せず、dirty／unsettled時のbeforeunload警告のみを追加した。新しいbrowser Back／reload非同期guardはない。全体suite・実LightCraft／GPU／Immich・Windows画面操作は実施していない。実画面受入はユーザー側で行う。README／CHANGELOGは変更していない。

## RAW現像統合 Phase 1C-C3-B：SQLiteレシピのLightCraft復元（2026-10-22）

Windowsの既存document openに、import→実content hash／engine/schema照合→SQLite lookup→全DevelopSettings適用→readback一致確認を接続した。C3-Aの正規化・JSON検証・256 KiB上限・receipt検証を再利用する。完全一致レシピだけを使い、当該Assetの行なしなら従来初期状態、原本やengineが異なる場合は区別した固定エラーでopenを拒否する。DB行・receiptの書換え／削除は行わない。

`restore_persisted_settings()`は再import後の同hashを確認して復元し、旧`restore_settings()`のfingerprint条件は変更しない。`lightcraft`／handshake `0.10.0`／固定adapter commit／settings schema 1を照合し、既存native reset・全merge・readbackを使用する。WB scale省略はlegacyのままでKelvinへ推測変換しない。C2未対応fieldも一致確認し、失敗・結果不明・古いselection/document/generationは成功確定しない。binary commitのhandshake証明は既存どおり未対応である。

documentにはopen由来の`recipeStatus`（none／restored）とSQLite側`recipeRevision`を追加し、Previewには既存native `revision`を使う。復元失敗時はdocumentを公開せずC1 cleanupへ進む。HTTP cancel／shutdownでも送信済み処理の所有を維持し、native解放前にcacheを削除しない。Windows profile選択前のDB path bindを避ける遅延importもテストした。設定本文・原本hash・PhotoId・pathの公開や新しい保存endpointは追加していない。

検証：repo Python 3.14／cwd backend、関連Backend 7ファイル275件＋41 subtests成功。Fake LightCraft＋一時SQLiteで同hash／異fingerprint、全設定、未保存、原本／engine不一致、readback不一致・通信結果不明、HTTP cancel、切替・世代更新・shutdown、DB行保持を確認。既存C1 cleanup／C2 controls・Preview、C3-A保存層、JPEG保存／Queueも成功。`git diff --check`成功。Frontendテスト／build、実LightCraft・GPU・Immich・Windows画面確認は実施していない。

C3-Bのみ完了。schema v7・保存規約・C2動作は維持し、Frontend Autosave、写真切替・終了保存guard、Gallery復帰の編集管理、resident／世代再生成／mutation容量対策はC3-C／Dへ残す。RAW History／Undo／Redo／Reset・Exportには着手していない。新しいC2編集はまだ一時的である。

## RAW現像統合 Phase 1C-C3-A：SQLite保存基盤（2026-10-22）

既存DBへschema v7として`asset_raw_recipes`と設定本文を持たない冪等受付記録`raw_recipe_saves`を追加した。レシピはAsset ID＋原本content hash＋engine名/version/commit＋settings schema versionで識別し、異なる原本・engine行を残す。`raw_recipe_store.py`が完全DevelopSettings JSON、recipe revision、saveId、保存時刻を管理し、JPEG Recipe v18／History／現像済み判定／Queueへ接続しない。C2スライダー・LightCraft・Frontendは変更していない。

保存は既存SQLite接続と`BEGIN IMMEDIATE`を再利用し、expectedRevisionとsaveIdで競合・冪等性を保証する。同一requestの再送は後続保存後も元のackを返し、異payloadへのID再利用を拒否する。receiptとcurrent recipeは同じtransactionでcommit／rollbackする。設定JSONはUTF-8最大256 KiB／深さ32／32,768 nodes、finite JSON・version/process/WBの構造を検証し、全fieldを保持する。内部handle／PhotoId／cache path等は保存しない。読込時も設定・metadata・receiptを再検証し、破損時は上書きしない。

検証はrepo Python 3.14／cwd backendでRAW保存層86件、既存のstorage／JPEG保存・status／Queue／Export復旧／除外設定の関連235件＋56 subtests成功。v1〜v6からのmigration・既存行保持、migration失敗rollback、複数identity、競合／並行保存／saveId replay、JSON上限、破損読込、実SQLite busy／SQLITE_FULL、書込・commit失敗を確認した。sandboxのpytest TEMP作成失敗は同じPythonの権限付き実行で回避し、長大parameter ID由来のテストTEMP pathエラー2件はIDを短縮して解消した。`release/smoke-test.sh`のschema期待値・RAW table検査を更新し、そのSQLite blockを新規v7テストDBで実行した。`git diff --check`成功。

利用中DBは操作せず、migrationはテストDBでのみ検証した。v6以前のBackendへ戻す際は整合したmigration前DB backupが必要。フルDocker Smoke Test、Frontendテスト／build、実LightCraft・GPU・Immich試験は実施していない。保存済み設定のLightCraft復元、RAW API、Frontend Autosave、写真切替保存確認、Session管理はC3-B以降。History／Undo／Redo等はC4、RAW Exportは後続工程であり、現在の暗室はまだ一時編集のまま。

## RAW現像統合 Phase 1C-C2：RAWスライダーパネル仕上げ（2026-10-22）

JPEG暗室とパネル配置を揃え、RAWのTemperature／Tintに既存JPEG gradientを適用した。基本補正の表示順をExposure → Contrast → Highlights → Whites → Shadows → Blacksへ変更し、RAW native control ID・値・現像処理は維持する。個別／カテゴリ／全体のON/OFF・ResetボタンはC4実装までdisabledで配置し、「RAWでは準備中」と示す。クリックやキー操作ではRAW設定を変更しない。

RAW暗室から未フォーカス状態で`Shift+↑／↓`を押した際、JPEG Historyを持たないRAWは従来の入口条件から除外されていた。RAW documentがreadyで操作を遮る画面状態がない場合に、JPEGと共通のフォーカス復帰を許可した。無効なWB rangeは候補から除外され、基本補正の移動は画面の行順に従う。Sliderの左右／上下step、wheel、数値入力、確定方法とJPEG動作は共有部品の既存処理を維持する。

検証：関連Frontend 4ファイル201件成功。未フォーカス時の初期focus、WB unavailableのskip、表示順、disabledボタンの非作用、gradient、RAW設定変更、JPEG White Balance／Color／Slider／暗室focus回帰を確認した。`npm run build`（TypeScript checkを含む）と`git diff --check`成功。既存の500 kB超chunk警告あり。実画面確認は未実施。

## RAW現像統合 Phase 1C-C2：LightCraftスライダー接続（2026-10-22）

開始HEAD `f21f3354c74c2193e504e17dd5b397245df3bfe3`、作業ツリーcleanから実装した。ユーザーによるC1のWindows/Tauri実機確認は完了。LightCraft画像と識別表示、および原本取得・`raw.document.ready`・`preview.completed`・`raw.preview.complete`の成功を確認済みの基盤として再利用した。LightCraft v0.10.0／固定commitを維持する。

Windows専用APIへsettings readback／resyncとallowlist controlsのPOSTを追加し、workspace・handle・generation・document tokenと`expectedRevision`を検証する。基本6項目（`light.exposure`／contrast／highlights／shadows／whites／blacks）に続き、`wb.temp`／`wb.tint`／`color.vibrance`／`color.saturation`を接続した。値域・step・初期値は固定v0.10.0のcontrol specから定義し、確定値とrevisionは必ずnative readbackを使用する。WBはinspectの有限なas-shot値と明示Kelvin scaleを確認できた素材だけ有効。scale省略・legacy・判定不能時はWBだけ無効にし、AsShot→Customはengine自身に任せ、JPEG相対補正へ変換しない。

既存`AdjustmentSlider`をRAW右パネルで再利用し、RAWではbypass／resetのボタンを表示しない。`RawControls`が150 ms debounce、commit flush、処理中1件＋最新未送信patch、desired値・確定値・最新入力serialを所有する。readback後にだけPreviewを要求し、取得後・decode後・表示直前のidentity／revision／serialで古い結果を破棄する。同一documentではzoom／panを維持する。競合はreadback再同期、結果不明は自動再送停止と明示的な再同期・再試行へ進む。離脱後のmutationは所有して回収するが成功表示せず、旧Slider callbackは新documentへ届かない。RAW値はJPEG Recipe／autosave／History／Exportへ渡さない。写真切替・終了で失う一時編集であることを表示し、C3の退避・容量管理、C4のBefore／Reset／Undoは追加していない。

暗室送りプリセットの固定ロックを廃止した。共有capability取得前・失敗・Windows利用不可・DockerのRAW route欠落では実効Non-RAW、Windows LightCraft利用可能時は3選択肢が有効。保存済みRAW／両方は上書きせず、capability回復で再適用する。既存Gallery／Stack手動形式選択の優先・fallback・Filmstrip順序は維持する。

最終検証はBackend関連4ファイル139件、Frontend関連15ファイル384件が成功。fake MCP／HTTP・gate・制御タイマーでcontrol mapping/readback、WB能力・AsShot／Custom・省略scale、mutationの切断・結果不明・競合、desired集約・stale Preview・離脱、プリセット保存・回復・Dockerロック、JPEG Slider／Viewer／保存・Stack選択の回帰を確認した。`npm run build`のTypeScript checkとproduction buildは成功し、既存の500 kB超chunk警告は残る。初回検証の旧fixture期待値・テスト用型定義の不一致は修正し、関連範囲で再確認した。全体suite・実GPU・実Immich・Windows画面操作は行っていない。C2の実画面受入はユーザーが行う。README／CHANGELOGは変更していない。

## RAW現像統合 Phase 1C-C1：Windows暗室へのRAW Preview接続（2026-10-22）

設計Commit `c912146f22c0f34fb5ea6d5364044c4fedd06c16`からC1を実装した。LightCraft v0.10.0固定commit `a2a41383c4fd62fa85a46ccd00998639221f2d3c`を維持する。既存のGallery／Stack形式バッジ・送信対象解決・暗室route・Filmstripの集合と順序を再利用し、RAW時だけLightCraft生成PNGをImageViewerへ接続した。既存JPEGのRecipe／History／Autosave／Queueを維持し、RAWのSlider／Undo／永続化／Exportは追加していない。

主な追加は`backend/raw_source.py`と`windows_raw_api.py`、`frontend/src/rawApi.ts`と`useRawDocument.ts`。`windows_local.py`が専用APIを既存認証wrapper内にmountし、shutdownではcancel耐性のあるownerがdownload・RAW session・HTTP task・cacheを回収する。共通Backend／Docker／JPEG限定original関数／LightCraft本体は変更していない。RAW取得は既存Immich資格情報を利用したGETのみで、原本pathとPhotoIdはFrontendへ返さない。

初期制限はRAW 512 MiB/file、cache 1 GiB/workspace、空きdisk 1 GiB、download全体120秒、disk I/O 5秒、JSON 4 KiB、PNG 5 MiB／最大辺1024。`.part`から完成fileへrenameし、失敗・離脱・終了時に所有directoryだけを回収する。停止したdisk workerや未回収processの参照を無視して削除しない。workspaceは180秒のlease（15秒ごと確認、表示中は30秒ごとの状態取得）を持つ。C1は1 active RAW／workspaceで、切替時に旧workspaceのRAW sessionをresetして解放するため、RAW往復は再download／再importとなる。2枚／256試行のPoC制限緩和やsnapshot退避はC3へ残す。

FrontendはRAWのgeneration／document token／revision／request serialとPNG header・decode寸法・decode後のdocument状態を確認し、stale結果を拒否する。JPEG用CPU／AdjustedImageを呼ばず、RAW表示中のJPEG WebGPU初期化も停止する。状態overlayでLightCraft生成・最大1024pxを示し、100%をPreview pixelの倍率と明示する。capabilityなしではImmichの閲覧用であることを表示するが、現像失敗を閲覧用画像で成功扱いしない。Blob URLだけの更新はzoom／panを保持し、切替・失敗・pagehideでURLを解放する。

自動検証は変更範囲ごとに分割実行した。BackendはRAW／MCP／runtime／Windows LocalHostを含む6ファイル199件成功の後、追加したdisk worker期限・shutdown・原本保護を含む2ファイル29件、最終API shutdown修正後のRAW取得／API／Windows LocalHostの3ファイル74件が成功し、lease失効回収を追加した最終APIテスト17件も成功（同一テストの重複実行を含む）。Pythonはrepo `.venv`の3.14、cwdはbackend。通常sandboxで非同期テストが進まなかったため、その実行processだけを回収し同じexecutable・引数の権限付き実行へ切り替えた。

Frontendの関連15ファイル496件では旧RAWパネル文言の期待値1件が失敗し、期待値をC1のRAW Preview専用表示へ更新した。修正後の保存／Viewer／混在暗室／RAW hookの4ファイル135件、GPU境界を含む3ファイル64件、最終API client／RAW hook／混在暗室／GPUの4ファイル34件が成功した。他の関連成功結果は変更との依存関係を確認して再利用した。通常sandboxのVitest一時module読取りエラーは権限付きで同じfocusedテストを再実行して解消した。TypeScript checkとVite production build成功。既存の500 kB超chunk警告は残る。全Frontend／Backend suiteは実行していない。`release/smoke-test.sh`も確認し、Windows専用TEMP cache／APIはDockerのstorage・起動契約を変えないため変更不要と判断した。フルDocker Smoke Testは実行していない。`git diff --check`成功。

成功判定の根拠は画像表示だけではなく、本物のPhase 1B adapterをfake MCPへ接続した`render_preview`の呼出し・PNG byte／metadata照合と、FrontendのJPEG renderer非呼出し・失敗時画像非表示・stale／URL解放テストである。実LightCraftや実Immichを呼び出した試験ではない。

実画面受入・正式コード監査は別工程。Windows/Tauri/WebView2、実Immich原本download、実LightCraft RAW現像／GPU、NAS／Firefox、PyInstaller、実GPU障害fallback、長時間memoryは未検証。README／CHANGELOGは変更していない。API契約・設計との差分・残課題の詳細は[Phase 1C設計書のC1実装追記](research/lightcraft/PHASE1C_DESIGN.md#phase-1c-c1実装結果2026-10-22)を参照。

## Phase 1C-C1実画面確認後のRAW Preview表示修正（2026-10-22）

Windows実機の診断JSONでは原本取得、`raw.document.ready`、`preview.completed`、`raw.preview.complete`が成功し、画面にもLightCraft Preview画像と識別表示が出ていた一方、中央の読込表示が残っていた。`ImageViewer`は`documentKey`変更時のpassive `useEffect`で読み込み状態と画像寸法を初期化していたため、同じコミットで先行した`<img onLoad>`のready更新を後からloadingへ戻し得る状態更新順序が原因だった。

画像状態と寸法を`imageIdentity`に結び付け、identity変更直後は同期的にloading／空寸法として扱う。load／errorイベントもidentity付きで記録し、zoom／panのreset effectは表示状態を変更しない。これによりRAW Previewの読込完了後に表示が消え、同一document内のBlob更新では既存のzoom／panを保ち、RAW／JPEG切替では前の画像状態を引き継がない。JPEGの表示・AdjustedImage経路は維持する。

回帰テストは親layout effectから画像loadを同期発火し、子のpassive effectよりloadが先に到着する順序を再現した。RAWのloading／ready／error、JPEGへの切替と読み込み完了を確認し、`ImageViewer.test.tsx`と`AnshitsuRawPreview.test.tsx`は53件成功、`npx tsc --noEmit`も成功した。実機での再確認は別途必要。変更対象は`frontend/src/ImageViewer.tsx`、同テストと本記録のみで、Backend／RAW現像／GPU／Immich試験は行っていない。


## RAW現像統合 Phase 1B：Backend内部RAW操作・Preview（2026-10-21）

設計確定commit `c1e2141068f097bbc2778d22c3f05ac3323cafb7`を基準に、Windows LocalHostが既存LightCraftManagerと同じlifespanで所有する`LightCraftRawSession`を追加した。RAW未使用時は追加task、import、GPU照会、memoryBudget設定を開始しない。HTTP endpoint、UI、Recipe／History永続化、Export、Immich／Stack操作は追加せず、共通Backend・Docker・Tauri・JPEG処理は変更していない。

内部Python操作はopen_raw、select、get_settings、set_controls、merge_settings、restore_settings、request_preview、reset_session、close、status。単一ファイルのmode addでimportし、photo.inspectのRAW種別・preview_only・寸法・content hashを確認する。原本・sidecarを書き換えるcommandやXMP auto-writeは有効にしない。複数RPCの操作lockで選択→設定適用→develop.getを直列化し、送信値ではなくreadbackを正本にする。全復元はreset→merge→getを照合し、processとWB scaleを保持する。途中失敗はdesynchronized、MCP切断はlostとして扱う。

通常RPCの1 MiB上限を維持し、render_previewの一致する応答だけ8 MiBまで許容した。PreviewはPNG長辺1024pxまで、画像5 MiB、metadata 16 KiB、1,048,576画素まで。Base64、contentとid／寸法、PNG chunkのCRCと終端、単一frame、Pillow verify／loadを検査する。実行中1件＋最新待機1件をBackend workerが所有し、generation、document token、selection epoch、requested／applied revision、sequenceで古い画像を破棄する。ticketのawait取消は送信済みMCPをcancelしない。画像検査は論理期限後も所有workerの完了を待ち、次の検査を重ねない。

PoC制限としてRAW／snapshot最大2枚、変更試行最大256回／generationを採用した。設定適用後のreadback失敗もnative Historyを増やし得るので試行に数える。明示resetは原本のfingerprintとcontent hashを照合して確定snapshotを復元する。restore_active=Falseは保持snapshotを明示解放する操作とし、再openは同一原本でもtokenを更新して旧handleを無効にする。世代別の私有TEMP／TMPを子processに渡し、通常応答後のPNG残骸と回収後directoryだけを掃除する。内部constructorのGPU指定はdx12（既定）／offだけで、親の任意GPU overrideは引き継がない。

Python 3.14のリポジトリ`.venv`で、RAW／MCP／runtime／Windows LocalHost／managed shutdown／Windows runtimeの関連Backendテスト185件が成功した（10.66秒）。fake MCPのreadback、連続Preview・stale破棄、画像検査中cancel、検査中close、復元失敗、256回制限、専用TEMPと実asyncio subprocessの8 MiB超stdout回収を含む。通常sandboxではWindows非同期テストが進まなかったため、今回のテストprocessだけを回収し、同じPython環境の権限付き実行で確認した。Backend全suite、Frontend／Tauri buildは実施していない。

今回は実LightCraftのRAW現像PoCを行っていない。GenzoRoom経由での2素材のimport・反復Preview・全設定復元、RX 580とCPU固定、実GPU障害fallback、時間・メモリ計測は次工程の未検証事項である。Tauri画面起動・JPEG暗室実画面操作、PyInstaller、Job Objectによる孫process回収も未検証のまま。Phase 1CのUI・永続化・最終Exportを完了したという意味ではない。

## RAW現像統合 Phase 1B：Windows開発Backend実機PoC（2026-10-22）

Phase 1B初期実装commitは`299bdb6a3485b5b879e34568cafba5c1181a8a52`。限定監査はHigh 0件／Medium 3件／Low 1件で、MediumはSession復元snapshot、TEMP I/Oの期限・所有、回収失敗時のstderr排出に関する指摘、LowはRAW読込拒否後の現在写真操作に関する指摘だった。修正後commit `1b7c4e0813f8be31709096c2f06af314a0fe8fda`で対応し、関連Backendテスト190件が成功した。監査後のHigh／Mediumは残っていない。

Windows 11（10.0.26300）、既存`.venv`のPython 3.14.5、LightCraft v0.10.0固定commit `a2a41383c4fd62fa85a46ccd00998639221f2d3c`で、開発用Windows `LocalHost`／Uvicornから内部Python interfaceを実行した。CLIは`I:\code\raw-test\lightcraft-v0.10.0-gpu-poc\target\release\lightcraft-cli.exe`、SHA-256は`9ca7a0483e3171805670f52af6fff1b8f93f78e10a32933e4f7c4fad872913d1`。検証用storageは独立directoryに隔離し、Immich環境変数を外して実施した。

Pixel 7 Pro DNGとPentax DNGのRAW読込・inspect、handleの対応、再open時の旧handle無効化、A→B→A切替を確認した。2枚保持時の3枚目相当要求は容量エラーとなり、その後再selectなしで既存写真の設定変更とPreviewが成功した。各素材でExposure `+0.25`／`+0.5`／`+1`／`-0.5`／`0 EV`をset_controlsとmerge_settingsで適用し、`develop.get`確定値と内部snapshotが一致した。`process=2`とWB scale `kelvin`を保持した。

PNG PreviewはPixel `1024×770`、Pentax `1024×683`で、PNG完全性・metadata・寸法を検証した。最大PNGは`1,161,088 bytes`、最大JSON行は`1,548,305 bytes`。目視確認した出力に不自然な向き、真っ黒画像、明白な色異常はなかった。連続要求で実行中Preview最大1件、待機要求の最新1件集約、superseded／stale結果の破棄を実CLIで確認した。caller cancel後もMCP pingは成功し、Preview中の設定変更は新revisionで画像を返し、Preview中closeは待機を解放して回収した。

Exposure `+0.5`のsnapshotをgeneration `1→2→3`で連続resetし、2回目のreset前に`get_settings()`を挟まなくても設定が維持されること、readbackとの一致、旧generation handleの拒否、reset後Previewを確認した。RX 580のDX12経路は`Radeon RX 580 Series (Dx12)`、enabled／availableともtrue。CPU固定は別processで実行し、同じ設定schemaとPreviewが成功した。Backend readyは約99〜101 ms、`/api/health`は検証前後とも200だった。

| 素材・経路 | import | 初回Preview | 継続Preview | 露光変更後 |
|---|---:|---:|---:|---:|
| Pixel DX12 | 27.4 ms | 903.3 ms | 91.5 ms | 90.9 ms |
| Pixel CPU | 29.7 ms | 876.3 ms | 94.0 ms | 92.0 ms |
| Pentax DX12 | 26.5 ms | 611.3 ms | 74.8 ms | 80.9 ms |
| Pentax CPU | 23.3 ms | 596.7 ms | 76.6 ms | 71.6 ms |

継続Previewは3回、露光変更後は5回の中央値で、内部APIのawait完了までを測定した。`open_raw`は登録・inspect・初期設定取得であり、RAW decodeは初回Previewに含む。少数回の測定でGPUが常に高速とはいえない。

2素材処理後のLightCraft OS memoryは次のとおり。Python BackendはWorking Set約84 MiB、Private Usage約547 MiB。`library.memory.engineBytes`はDX12／CPUとも約109.4 MiBで、native cacheとOS process memoryは別指標。Private Usageはsnapshot時点値でありpeakではない。

| 経路 | Working Set | Private Usage | Peak Working Set |
|---|---:|---:|---:|
| DX12 | 356.5 MiB | 782.8 MiB | 467.1 MiB |
| CPU | 130.0 MiB | 121.0 MiB | 308.6 MiB |

正常終了・reset・Preview中closeを含む10個の検証CLI processはすべてreturn code 0で回収され、関連reader／stderr／wait／RAW workerと世代専用TEMPも残らなかった。検証前後でRAW原本と存在するsidecarのfingerprintは一致し、既存GenzoRoom DBとImmichは操作していない。測定・出力・詳細は独立PoC記録`genzoroom-phase1b-poc-20261022/RESULTS.md`に保存されている。

完了判定：**Phase 1B Windows開発Backend実機PoC：PASS**。これは指定したWindows開発環境と内部Backend interfaceによる短時間PoCの範囲に限る。GPU障害からのCPU fallback、全タイミングの非同期競合、長時間メモリリーク、Tauriホスト経由の起動・終了、JPEG暗室の実画面操作、PyInstaller配布版DLL検索、Windows Job Objectによる孫process回収、RAW暗室UI、Recipe／History永続化、最終Export、Immich統合は未検証でありPASSに含めない。RAW最大2枚と変更256回／generationはPoC制限で、正式な製品仕様ではない。

## RAW現像統合 Phase 1A：常駐MCP接続基盤（2026-10-21）

実装commit `8cf74987d509620434942b00598144879068312e`で、Windows `LocalHost`のlifespanにPython Backendが1つのLightCraft headless MCPを所有する基盤を追加した。`lightcraft_mcp.py`は改行区切りJSON-RPC、ID対応、通知分離、要求直列化、timeoutと応答検証を担当し、`lightcraft_runtime.py`の`LightCraftManager`は起動、初期化、状態・generation、GPU情報、終了・明示再起動を担当する。内部操作は`start()`、`close()`、`restart()`、`ping()`、`get_gpu_info()`と同期`status()`。HTTP endpointやUIは追加していない。

`GENZOROOM_LIGHTCRAFT_EXE`の絶対pathを使い、未設定・非Windowsでは`disabled`とする。起動taskはWindows Backend readyを待たせず、LightCraft失敗時にも共通Backendと既存JPEG処理を継続する。起動時に`lightcraft`／`0.10.0`／protocol `2025-06-18`を検証する。固定commit `a2a41383c4fd62fa85a46ccd00998639221f2d3c`は開発基準で、handshakeからcommitを識別できるわけではない。stdoutは最大1 MiBのLF区切りJSON-RPCを検証し、stderrは継続読取するが原文をログへ残さない。子process環境は必要なWindows runtime情報に絞り、GPU backendをDX12に固定する。`app.gpu`を検証して返し、GPU不可でもMCP通信の`ready`は維持する。

初回の関連Backendテストは113件成功した。続く限定コード監査はHigh 0件／Medium 3件／Low 0件で、3件はいずれも終了・プロセス回収に関する指摘だった。監査後修正commit `5a9e0f977579a27cd4131ec2034f0ad156519aae`で、stdout読取り停止後のpipe排出、ownerとexit watcherの同時cancel時のcleanup、実行file検査・SHA-256計算中の終了処理を修正した。修正後は実asyncio subprocessによる過大stdout、検査中close／期限超過、owner・exit watcher同時cancelを含む関連Backendテスト117件が成功し、再監査の残存High 0件／Medium 0件となった。

## Phase 1B限定監査後の修正（2026-10-22）

監査対象commit `299bdb6a3485b5b879e34568cafba5c1181a8a52`の限定監査はHigh 0件／Medium 3件／Low 1件だった。復元後の確定設定がPython snapshotへ未反映、TEMP作成・削除I/Oが期限外、回収失敗後にstderr drainを停止する問題を修正した。RAWの事前拒否が現在写真の選択意図を消すLow指摘も修正した。

`reset_session()`の再importはreset→merge→`develop.get`の確定値を新handleのsnapshot／revisionへcommitする。RAW file fingerprint・容量などの事前拒否はselection epochを変更する前に行う。実行開始後の失敗は要求epochが最新で、旧写真・generation・同期状態が有効な場合だけ選択tokenを復元する。epochは進めたままなので古いPreviewは再有効化しない。

LightCraft専用TEMPは解決後のrootがWindows固定ローカルdriveであることを確認し、UNC・network driveを拒否する。resolve・作成・Preview残骸削除・終了時削除はevent loop／default executor外のdaemon I/O workerで期限付き実行する。期限超過したworkerをcancelしたものとして扱わず、世代専用pathとper-session lockを保持する。子process回収前およびTEMP cleanup未完了の間はsession ownershipを保ち、restartを拒否する。stderr drainはprocess未回収中に止めず、回収成功後にjoinする。stderr本文は引き続きログへ保存しない。

回帰テストは、readbackなしの連続reset、3枚目拒否後の既存写真編集／Preview、停止するTEMP作成・Preview cleanup・終了cleanup、Windows UNC root拒否、および実asyncio subprocessの初回reap失敗→大量stderr→再回収を追加した。関連Backend 6ファイルは**190件成功**。Phase 1AのMCP／プロセス回収とWindows lifecycle関連も同じ実行で成功した。実LightCraftによるRAW／GPU検証、任意のnetwork filesystemの実停止挙動、Job Object／PyInstallerは未検証である。監査後のHigh／Medium残存はなし。

Windows 11開発環境ではPython 3.14とWindows `LocalHost`／Uvicornから実LightCraftへ接続した。使用CLIは`I:\code\raw-test\lightcraft-v0.10.0-gpu-poc\target\release\lightcraft-cli.exe`、LightCraft v0.10.0、SHA-256 `9ca7a0483e3171805670f52af6fff1b8f93f78e10a32933e4f7c4fad872913d1`。MCPの`initialize`、`notifications/initialized`、`ping`が成功し、managerの`ready`を確認した。Backend readyは約90〜108 msで、LightCraft GPU初期化を待たなかった。GPU応答は`enabled=true`、`available=true`、`Radeon RX 580 Series (Dx12)`だった。

明示`restart()`はgeneration 1から2へ進み、再接続に成功した。検証用CLIだけを異常終了させるとmanagerは`lightcraft_eof`で`failed`になり、Backendは継続し、明示restartで復旧した。環境変数未設定では`disabled`、不在pathでは`lightcraft_executable_missing`となり、いずれもBackendは起動を継続した。通常終了と起動途中のcloseで対象CLI、MCP reader、stderr、owner／wait関連taskを回収した。検証後に対象processは残らず、GenzoRoom作業ツリーもcleanだった。

完了判定：**Phase 1AのWindows開発Backend接続基盤：PASS**。

この判定は開発BackendからのMCP・RX 580/DX12接続とmanager lifecycleの範囲に限る。Tauriホスト経由の画面起動・通常終了、既存JPEG暗室の実画面操作、PyInstaller配布版のDLL検索と外部CLI起動、Windows Job Objectによる異常終了時の孫process回収、RAW import／DevelopSettings／Preview／ExportのGenzoRoom統合は未検証であり、PASSに含めない。Recipe、History、暗室UI、Immich操作を含むPhase 1B以降の機能は未実装である。

## LightCraft研究資料の収録（2026-10-20）

[LightCraft研究資料](research/lightcraft/README.md)に基準バージョン、既存Windows/Linux PoC実測、Engine API調査、統合候補と最小PoC案を整理した。既存実測・ソース上の事実・設計提案・未検証事項を区別している。今回は文書収録のみで、GenzoRoom実接続、ビルド・現像の再実行、QNAP実機確認は行っていない。

## Windows Phase 3C：NSIS配布・正式アイコン（2026-10-19）

Tauriの配布専用overlayに正式名`GenzoRoom`、固定identifier `com.genzoroom.desktop`、NSIS currentUser、`%LOCALAPPDATA%\Programs\GenzoRoom`のアプリ配置、offline Evergreen WebView2導入を設定した。ユーザーデータは正式版の`%LOCALAPPDATA%\GenzoRoom`に独立して保持し、アンインストールの再帰削除とPoC参照を含めない。標準NSISのアプリ終了・Restart Manager経路を除き、Rustホストと共有するMutexをインストール／アンインストール開始前に保持する。起動中・ロック取得失敗時は通常・silentの両方で中止し、アプリを終了しない。過去のPoC identifierや開発設定は変更していない。

元Reactバッジを16/24/32/48 px、復元済みの無変更`design/genzo_icon_fix.svg`を64/128/256 pxに割り当てる再現可能なPNG/ICO生成器を追加した。作業ツリー内の元SVG SHA-256、個別frameの一致、PEホスト／セットアップ埋め込みのサイズをテストする。

`desktop/packaging/build.ps1`でReact production build、PyInstaller onedir、Backend runtime check、Tauri x64 Release、NSISセットアップ生成まで完走した。出力は`desktop/packaging/out/20261019-194459-70ef347a/`で、セットアップは255,708,267 bytes（243.86 MiB）、実行フォルダーは約100.8 MiB。完了manifestにツール版、Backend manifest、ホスト／インストーラー／アプリ同梱物のSHA-256と長さを記録する。local validation version `0.0.0-validation`は正式リリース番号として確定していない。

検証途中にTauri CLIの`--release`が未対応であること、NSISカスタムテンプレートのStart Menu／Desktop shortcut関数欠落を実ビルドで発見・修正した。生成したセットアップPEとホストPEのアイコンframe検証は通過した。実インストール・更新・アンインストールは実行していない。検証時に既存の共有Mutexが存在し、所有プロセスを安全に特定できなかったため、ロックされた状態でインストーラーを起動しない判断をした。

配布資料にはGenzoRoom AGPL、Python、Frontend production、Windows x64 Cargo依存のライセンス一覧／存在する原文noticeと対応ソースZIPを含める。306依存のうち6 Cargo crateのライセンス本文、NumPy/Pillow DLL・codecの正確な構成、WebView2 standalone再配布条件とEULA、NSIS/LZMA配布条件、公開配布ソースURLの確認が残るため、今回のEXEはローカル検証用であり公開配布の受入は保留。Phase 3Dの隔離実機テストとライセンスレビューをRelease blockerとして記録する。

## Windows Phase 3B：Python Backend同梱（2026-10-19）

PyInstaller onedir、Tauri resources、既存Rust Command／Job Object／私有パイプの構成を実装した。配布専用のhash付きPython lockとspecを追加し、Frontend production buildも凍結物へ含めた。console-subsystem BackendとCREATE_NO_WINDOWを維持し、Shell Pluginや包括的ファイル権限は追加していない。開発用`.venv`と配布用の明示Cargo featureを分離し、Lifecycleが同じ絶対パスの起動設定を再起動にも保持する。

正式版は`%LOCALAPPDATA%/GenzoRoom`、PoCは既存`WindowsPoC`、資格情報参照名も別namespaceとした。import前のDB/cacheルート確定、プロファイルID、終了保存、永続Export Stop、DPAPI/HMAC、Cookie、Mutexは維持した。既存PoCを移行・削除する処理はない。Frontendの操作・レイアウト、Dockerの起動や依存定義・永続化、DBスキーマは変更していない。

初回の実onedirを外部一時フォルダーへコピーし、native/WebView2の既存17ケースが成功した。内容は接続設定更新と再起動・React文書更新、SQLite障害復旧、プロセス正常停止／異常回収、起動競合／タイムアウト、初回bootstrap失敗、JSON保存／キャンセル／失敗通知を含む。新しい実凍結EXEテスト3件はPATHをWindowsシステムだけに限定した起動、外部Python設定非依存、DPAPI/HMAC/Cookie、正式DB・PoC保持、ネイティブ自己診断、Backend欠落時のホスト固定コードを確認した。実ユーザーのデータやImmichは使わず、生成JPEG・loopback fixture・ランダムCredential参照のみを使用した。

関連Backendは241件・118 subtests、Frontend境界3ファイル17件、Rustは開発／bundled両モード各18件が成功。Clippy両モード、Rust fmt、Frontend TypeScript/Viteと実PyInstaller／Tauri Release生成も成功した。最初のsandbox内Rustテストでloopback到達失敗が1件あり、同じコードの権限付き実行で成功を確認した。既存Vite chunkサイズ警告、PyInstallerの非Windows／任意モジュールの解析警告（tzdata等）は残るが、実行対象経路に必要な追加hookは確認されなかった。certifiのCA読込みは確認したが、実HTTPSサーバーとのTLS疎通を保証しない。

限定監査の初回FindingはHigh 0／Medium 1／Low 0。resources出力は追加コピーのため前回の古いDLL等が残り得るのに、inventoryが記載ファイルだけを検証していた。同じ根本原因により、別コピーを配布するとTauri resources設定の誤りも隠せる。生成resourcesだけを明示的に削除し、当該Cargo packageをcleanしてbuild scriptを再実行、実際のCargo出力resourcesを検証・配布するよう修正した。余剰・欠落ファイル、SHA-256とサイズ、全Frontend成果物、x64 PE/subsystem、内外manifest一致を検査し、最後だけdistribution-completeを作成する。破損・欠落・旧DLL注入の決定的テストで再検証した。残る配布上の条件はクリーンWindows VM、実写真／実Immich、署名・WebView2導入・NSIS、ライセンスの最終精査であり、Phase 3C/3Dへ送る。既知共通Export COVER問題には着手していない。

同梱smokeでPoC保持sentinelを含むnative統合＋凍結EXEは20 passed／1 skipped（通常配布GUI専用ケース）。従来PoCのnative統合も17 passed。smoke機能なしの通常配布物では3 passed／1 skipped（エラーダイアログを抑制するsmoke専用ケース）で、リポジトリ外のGUI起動・bootstrap認証・WM_CLOSE・子Backend停止を確認した。これらは開発PC上の自動native fixtureであり、クリーンVMや人による操作確認を意味しない。

修正後の限定再監査はHigh 0／Medium 0／Low 0。厳格inventory検証を通った最終の非smoke成果物でも外部配置の3 passed／1 skippedを再確認した。Backend共通コードは既定の`/genzoroom`を保持し、release smokeの保存先・起動期待値に変更は不要と確認した。Dockerコンテナーのrelease smoke自体は今回実行していない。

今回の変更ファイル（Phase 3B開始時の作業ツリーはclean）:

- Backend: `storage.py`、`windows_connection.py`、`windows_credentials.py`、`windows_local.py`。追加: `windows_runtime.py`、`windows_runtime_check.py`。
- Backend tests: `test_windows_process.py`。追加: `test_windows_runtime.py`、`test_windows_bundle.py`。
- Rust: `desktop/Cargo.toml`、`desktop/src/backend_process.rs`、`connection.rs`、`lifecycle.rs`、`main.rs`。追加: `backend_launch.rs`、`host_diagnostics.rs`、`desktop/tauri.bundle.conf.json`。
- 配布buildの追加: `desktop/packaging/{runtime.in,runtime.lock,build.in,build.lock,backend.spec,package_backend.py,verify_bundle.py,build.ps1}`。
- 文書: `docs/windows-tauri-poc.md`、`docs/development-notes.ja.md`、`docs/architecture.md`。README、CHANGELOG、Docker関連設定、Frontendソース、既存アイコン、Git履歴は変更していない。生成物は既存ignore規則で除外されるため`.gitignore`の追加編集は不要だった。

ライセンスは実収集module/DLL/dataと各ファイルhash、元license文書、依存バージョンを生成する基礎資料まで。GenzoRoom AGPL対応ソース、NumPy wheel同梱GCC runtime等、Pillow codecs、certifi MPL、Python／PyInstaller bootloader、Microsoft、Rust／Frontendの再配布条件を正式配布までに確認する。既存npm lockのsource-map-jsに対するnpm audit警告は別途依存更新対象で、Node/buildツール自体を配布物へ入れていない。クリーンVM・OS手動操作の未検証を自動テスト成功と混同しない。ビルドと起動の手順は[Windows運用文書](windows-tauri-poc.md)を参照。

Homeの現行仕様はGallery系4タブ（Recent / Albums / Calendar / Favorites）と管理系のSTACK管理／Export・出力管理の2タブで、Recentは50〜500件を50件刻みで選択でき、初期値は100件。以下の過去フェーズに記した件数や「未実装」は当時の仕様を示す。現在仕様はこの冒頭節、README、architecture.mdを参照する。

## Windows Phase 1・2 完了記録（2026-10-19）

起動・HMAC/Cookie認証、設定保存・profile再利用・Backend再起動、編集保存失敗後の再試行、Export Stop／復旧、Job Objectの正常／異常終了を横断検証した。既存Backend全体回帰は1213件＋326 subtests成功、8件のOpt-in nativeテストskip（追加nativeケースは別実行）。Frontend全体初回は2964件成功・2件skip・9件失敗で、7件は`DesktopLifecycleProvider`の静的描画時`window`参照を修正し、2件は並列実行時のGalleryタイムアウトで関連単独実行では再現しなかった。修正後のAnshitsu／Gallery／JSONの関連121件、終了保存・Settings・Developer関連144件は成功。全体suiteを不必要に繰り返さず、修正境界を再検証した。

Medium FindingはDeveloper JSON保存（保存先なし・連続自動ダウンロード抑止・完了通知なし）、キャンセル後の`Finished(false)`二重通知、通常起動で選択済みDBが使用不能な場合の回復経路不足。WebView2標準Blobダウンロードに検証済みDeveloper画面だけのnative保存先選択・自動ダウンロード許可・完了通知を接続し、取消／拒否後のFinishedは受理済みURL集合で除外する。初回Backend起動失敗は既存のunconfigured回復起動を再利用し、固定ポート競合／タイムアウトは元の明示エラーを維持する。High Findingはなし。Lowの静的描画参照は修正、並列テストの時間制限は既知事項として保持する。

実WebView2の3種類JSONは一時保存後に再読込みし、元BlobとSHA-256・UTF-8 JSONの一致を検証する。取消、書き込み不能な保存先、新スキーマSQLite、実writer lock、Backend強制終了、起動待ち0秒の注入もsmoke専用ビルドで検証する。テストは生成JPEGとローカルImmich fixtureだけを使い、実写真・NASへの書き込みは行わない。通常ビルドには保存先注入を含めない。

最終native／WebView2 14件、Rust7件成功。停止完了後に新Runtimeで復旧しても登録済みAssetを再登録しないことと未処理Queueの保持を追加検証し、managed／recovery関連61件が成功。TypeScript／Vite、通常／smoke Cargo build、Clippy、Rust fmt、`git diff --check`成功。既存Vite chunkサイズ警告とCargo incremental cacheのhard-link不可によるcopy警告は残る。今回の横断監査は初回High 0／Medium 2／Low 1で、M1・M2・L1を修正後の限定再監査はHigh 0／Medium 0／Low 0。自動検証と過去の基本動作確認をもってPhase 1・2開発工程をクローズした。実機で未実施・保証範囲が限定される項目は、完了を妨げない確認事項として[Windows PoC運用記録](windows-tauri-poc.md)にまとめた。

可視保存ダイアログ、日本語パス・上書き確認、OS実キー／IME、STACK DnD、Slider・Viewerの手触り、全画面・DPI・最小化復帰、実写真Exportは、必要になった段階で再評価する未確認事項であり、今回のPhase完了を妨げない。[状態遷移と手動復旧](windows-tauri-poc.md)を参照。Dockerの環境変数・保存先・Export／JPEG経路、README、アイコン、配布構成は変更しない。

## Windows Phase 1・2監査Findingの修正（2026-10-19）

終了要求の正本をRustのmutex保護状態へまとめ、Frontend準備状態を未起動・Ready・Reloadingに分けた。Backend異常終了時は保留中の一致request IDだけを解除してReactへ通知し、遅延応答・古い通知・重複終了通知を状態遷移テストで確認する。終了保存中に文書遷移が起きた場合もGuarding中の該当要求だけを取消し、BackendのExport受付を戻す。Drainingへ移った終了は既存Backend待機側の所有を維持する。

初回FrontendがReadyにならない場合は、React rootを`inert`に保ったまま、ホストが既存ManagedControlのprepare／graceful shutdownを実行して終了できる。Ready後の再読み込み中に終了する場合は、未保存内容が失われる可能性をWindows確認ダイアログで示し、拒否すれば継続、確認すればBackendの正常停止を待つ。実WebView2隔離smokeはbootstrap認証失敗・React ready応答失敗からの終了とBackend子プロセス消滅を確認する。Backend停止後に旧画面が残るケースは使い捨てLOCALAPPDATAで再現し、旧Tauriが生存する間の2つ目のホストを名前付きMutexで拒否してBackendを起動しない。旧画面のCookieを別Backendへ直接送る試験は行わず、二重起動を成立させない経路を確認した。

`--environment-backend`のSettings metadataは環境変数の有効URLとキー設定有無だけを表示する。保存済みURLや保存済み資格情報状態は診断接続先として返さない。通常の保存済み接続管理とDockerの環境変数経路は維持する。限定再検証ではRust17件、Backend接続・managed・export関連115件、Frontend lifecycle／Recipe保存／History編集182件、初回Frontend未準備・旧WebView隔離WebView2 smoke3件が成功し、TypeScript／Vite build、Clippy、Rust fmt、通常／smoke build、`git diff --check`も成功した。未保存編集終了の最終実機確認、Reloading確認ダイアログの手動操作、保存失敗の実機注入、Export終了、OSログオフ／終了通知、Cookieの別Backend送信直接試験は未実施事項として記録し、Phase完了を妨げない。外部ライブラリ由来シングル素材のSTACK COVER／Gallery表示不具合はWindows・Docker共通Exportの既知別課題で、今回の完了判定に含めない。
## JPEG Historyを操作境界で確定（2026-10-26）

JPEG暗室のkeyboard／wheel調整は、同じAdjustmentを続けて操作する間、入力間隔やAutosaveでHistoryを分割しない。別Adjustmentの操作開始、Viewer操作、Undo／Redo、History Jump、Adjustment Reset、Category Reset／Toggle、Individual Adjustment Toggle、All Reset、Paste、Asset／Filmstrip切替、暗室離脱や保存・終了処理でgestureを確定する。pointer dragはpointer終了、数値入力はEnter／blurで確定する従来の境界を維持する。

Autosaveはpending gestureを含む保存用snapshotを作るが、live sessionのgestureは継続する。History圧縮は既存機能として維持し、gesture確定の代わりには使わない。保存形式や既存Historyの書き換えは伴わない。

## STACKゴミ箱予約の元COVER条件見直し・実機確認完了（2026-10-21）

従来は取得時点の元COVERを永久保護していたため、別AssetへCOVERを変更した後も元COVERをTrash予約できなかった。予約条件を現在COVER基準に整理し、元COVERでも現在非COVERの元Stack memberなら予約可能とした。RAW、現在COVER、元Stack memberではない追加素材の保護は維持する。retained trashSourceを使うMANUAL retryでも同じ条件を適用する。

Album正規化では、予約AssetをAlbum cleanup対象外とする既存方針を維持する。新COVERへAlbum membershipを先に集約してStackを更新し、Stack成功後の既存Trash安全確認を通してから`force: false`で通常Trashへ送る。Trashが失敗してもStack成功を維持し、予約AssetのAlbum membershipを明示削除しない。

利用者からの実機確認報告では、元COVER JPEGから別JPEGへCOVERを変更し、元COVERをTrash予約してImmichへ送信した結果、新COVERが正しく維持され、元COVERが通常Trashへ入り、Album表示も期待どおりだった。実機挙動は問題なし。2026-10-09の監査記録にある元COVER保護は当時の監査・実装履歴として残し、本記録でその条件を見直した。

## Gallery除外設定警告のStack判定修正（2026-10-21）

Recentでは警告が出ず、Albums / Calendar / Favoritesでは「除外設定された写真の状態を確認できませんでした」という警告が出ることがあった。Calendarでは写真自体は正常に表示されていた。

ImmichのStack snapshotに`primary_not_member`のinvalid Stackが5件あり、snapshot全体が`complete=false`になっていた。対象Stack自体はそのinvalid Stackではなく、Stack IDとmembershipは識別可能だったが、Backendが全体の`complete=false`を理由に、無関係な不存在Stackまで`unknown`としていた。

修正では`membership_identifiable`と既知invalid Stack IDを使い、snapshotが不完全でも対象IDを有効Stack・既知invalid Stackのどちらにも見つけられない場合は、その対象に限り`absent`と判定する。対象Stack自身がinvalid、またはStack IDを識別できない場合は`unknown`を維持する。Frontendは`absent`を正常に取得した状態としてload failure警告から除外する一方、Galleryが持つStack構成が古い可能性を考慮し、`known`と各操作ガードは従来どおり別判定で維持した。

エラーメッセージから「現像対象外」の表現を廃止し、load failureを「除外設定された写真の状態を確認できませんでした。再読み込みしてください。」へ変更した。save failureも「除外設定」に用語を揃えた。

Backend focused testは69件、Frontend focused testは107件成功。TypeScript typecheckと`git diff --check`も成功した。Frontend build、Frontend / Backend全テスト、Rust tests、Cargo build、Docker Smoke Testは未実施。利用者による実機確認でAlbums / Calendar / Favoritesの警告が消え、Recentでは元々再現していなかったことを確認済み。

## Album内StackのExport正規化完了記録（2026-10-20）

当初、Album内の素材をExportして新しいStack COVERを作ると、新JPEGがAlbumに所属せず、GenzoRoom Album Galleryから写真が消える問題があった。STACK管理でAlbum membershipを最終COVERへ正規化した後は、非COVER source自身がAlbum非所属になるため、Exportもsource単体ではなく、操作時点のStack全memberのAlbum所属の和集合を新JPEGへ継承する必要が生じた。この修正でGenzoRoom Gallery上の表示は戻った。

その後の実機確認では、ImmichネイティブAlbumに新COVERと旧COVERが2枚表示された。GalleryはStack非COVERを除外するため、Galleryの表示件数だけを確認するテストでは、Immichの生Album membershipに旧COVERが残る問題を検出できなかった。ExportでもStack/COVER確定と新COVER検証の後に最終Stackの非COVER memberを継承Albumから外すcleanupを追加し、BackendテストはGallery結果に加えて生のAlbum membershipをassertするよう強化した。

最終確認では、Immich実機でAlbum内Stackの非COVER JPEGを編集・Exportし、新JPEGがCOVERとなり、旧COVERがAlbumから外れ、ImmichネイティブAlbumとGenzoRoom Album Galleryの両方で新COVERだけが表示されることを確認した。実機確認はOK。

このAlbum / Stack / Export修正をDocker / GHCR版のbugfix release v0.2.3（2026-10-20）の対象として確定した。Windows desktop版は共通修正を取り込んでいるが、別開発ラインとして今回のリリース対象外。

## 色温度補正方向とスライダー表示の統一（2026-10-15）

旧仕様ではTemperatureの正値が青方向、負値が赤方向へ画像を補正していたため、一般的な現像ソフトの補正方向と逆だった。White BalanceとShadows／Midtones／Highlightsの3WAY Temperatureを共通のRGBゲイン方向へ修正し、負値は青・寒色、0は無補正、正値は赤・暖色とした。JPEGのTemperatureは引き続き−100〜+100の相対補正であり、数値をKelvin値として表示・解釈しない。

スライダーのグラデーションは補正後の色ではなく、色温度の低高を表す。そのためWhite Balanceと3WAYで共有する配色を、低温側の赤橙 `#d86943` → 0のニュートラル `#b6b6b6` → 高温側の青 `#4e8ed9` に戻した。将来RAW現像で絶対色温度（K）を扱う際も、低Kの暖色から高Kの青色という軸に揃える設計意図である。RAW色温度補正自体は未実装。

Recipe形式・schema versionは変更せず、保存済みRecipeのTemperature数値移行も行わない。保存値はそのまま保持し、新方向の意味で適用する。Tint、処理順、History／Undo/Redo、Backend出力とサムネイル経路は変更していない。

検証：色温度補正実装時のFrontend CPU・3WAY・WebGPU関連Focusedテストは311件成功、1件skip。実WebGPUランタイムが必要な比較テストはskipされた。BackendのJPEGレンダラーとサムネイルJPEGプレビュー描画のFocusedテストは10件成功。非同期`generate_thumbnail()`全体の統合テストは実行中に停止したため完了未確認。今回のグラデーション更新ではWhite Balance／Color Grading UIの関連テスト72件、TypeScriptチェック、本番build、`git diff --check`が成功し、本番buildには既存の500 kB超chunk警告があった。実WebGPU・非同期サムネイル統合・実ブラウザー・NASでの確認は未実施。

## 色温度スライダーの補正方向表示へ再調整（2026-10-15）

Temperatureスライダーのグラデーションを、低温から高温を表す配色ではなく、JPEGの相対補正方向に合わせて青・寒色（左／負値）→ニュートラル（中央／0）→赤橙・暖色（右／正値）へ戻した。White Balanceと3WAYは同じ配色を共有する。色温度の画素補正式やRecipe数値は変更していない。JPEGは引き続き−100〜+100の相対値で、Kelvin表示は行わない。将来RAWで絶対K値を使う場合のスケール対応は別途定義が必要。

検証：White Balanceと3WAYの関連表示テスト72件が成功。TypeScriptチェック、本番build、`git diff --check`も成功し、本番buildには既存の500 kB超chunk警告があった。実ブラウザーとNASでの表示確認は行っていない。

## 暗室ショートカットとXアイコン表示の改善（2026-10-15）

### 暗室没入プレビューの左右キー操作

- 従来のPrimary+Shift+左右キーに加え、没入プレビュー中だけ左右キー単独で前後の写真へ移動できるようにした。通常の暗室ではスライダーの左右キー操作を維持する。
- Filmstripの既存キーボード処理を拡張し、`viewerFocusMode`を参照する。captureフェーズで`preventDefault()`を行い、スライダーにフォーカスが残る場合や写真の先頭・末尾でも調整値が変わらないようにした。
- 写真切替には既存の`onActivate`経路を使用し、Recipe保存などの切替処理は変更していない。IME、入力欄、ダイアログ、メニュー、キーリピート、切替中などの既存ガードも維持した。
- 利用者によるFirefox実機確認はPASS。

### Xボタンの表示統一

- FilmstripとSTACK管理のX文字に視覚的な位置ずれがあったため、フォントに依存しない共通インラインSVG（`frontend/src/XIcon.tsx`）へ置き換えた。Filmstrip除外、STACKグループ解除、STACKメンバー除外の3ボタンで共用する。
- FilmstripのXは当初16pxで実装したが、実機で大きく見えたため14pxに調整した。STACK管理も14px。既存のボタン寸法、位置、操作、disabled状態、`aria-label`、`title`は維持した。
- 利用者による最終表示確認で受け入れられた。

### 検証

- 没入プレビュー操作の関連Frontendテストは103件成功し、そのうちFilmstripテストは33件成功。Frontend全体実行は2,934件成功・2件skip・1件タイムアウトで、該当テストの単独再実行は成功した。Backend全体テストは長時間終了せず中断し、結果未確認。
- Xアイコン共通化時の関連Frontendテストは170件成功。TypeScriptチェック、Frontend build、`git diff --check`も成功し、buildには既存の500 kB超JSチャンク警告が残った。
- その後のFilmstripアイコン14px調整ではFilmstripテスト33件が成功し、`git diff --check`も成功した。この調整後はTypeScript/buildとFrontend・Backend全体テストを再実行していない。

### Filmstripのスクロール操作改善

#### 手動スクロール位置の維持

従来は、Filmstripを手動スクロールして別の写真を探していても、非同期処理などで`assets`、`disabled`、`keyboardBlocked`が更新されると、現在の写真へ自動的に戻っていた。修正後は写真IDの切替または実際のRecipe変更時だけ自動追従し、それ以外では手動スクロール位置を維持する。

`useAssetEdits`にRecipe変更専用のrevisionを設け、編集dispatchの前後でRecipeを比較して、実際にRecipeが変わった場合だけrevisionを進める。保存完了、データ読込、Historyだけの変更、フォーカス移動は自動追従のきっかけにしない。写真除外でactive写真が切り替わった場合は新しい写真へ追従する。Recipe、History、Undo／Redo、永続化の既存仕様は維持する。

#### ホイール横スクロール

- Filmstrip上の縦方向ホイール入力を横スクロールへ変換し、上方向で左、下方向で右へ移動する。
- 水平入力はブラウザー標準処理を維持し、独自の二重スクロールを行わない。
- スクロール範囲内に位置を制限し、左右端で停止する。変換した縦入力は端でもキャンセルし、CSSのoverscroll containmentと併せて意図しないスクロール連鎖を抑える。
- サムネイル、バッジ、除外ボタン上でも操作できる。ホイールでは写真選択・切替やRecipe編集を行わず、既存の写真切替・編集時の自動追従にも影響しない。

#### 検証

- スクロール位置維持の関連Frontendテスト139件成功。TypeScriptチェック、Frontend build、`git diff --check`成功。最初の並列テスト実行は一時領域のファイル参照エラーで失敗したが、単一workerで再実行して全件成功した。Firefox／NASでのユーザー実機確認はPASS。
- ホイール横スクロールの関連Frontendテスト146件成功。TypeScriptチェック、Frontend build、`git diff --check`成功。Frontend buildには既存のJSチャンクサイズ警告があった。Firefox／NASでのユーザー実機確認はPASS。
- Firefox／NASでの結果は利用者による実機確認であり、CodexがブラウザーやNASを操作したものではない。

## STACK作成後のGallery所属情報と再取得（2026-10-14）

### 現象と診断結果

Calendarの日付詳細で単独写真をまとめてSTACK化し、Immichへ送信すると、Gallery復帰後にX現像対象外の状態確認警告が発生した。同じ日付の写真を再びSTACK管理へ送ろうとしても遷移できず、別日へ移動すると復旧する場合があった。Firefoxのスーパーリロードで復旧した例も報告された。

利用者提供の統合診断ログでは、STACK作成11件がすべて成功した後、23件の旧単独Assetに対する状態照会へBackendが`stacked`を返し、Frontendに`configuration_mismatch`が発生した。その後、11 STACKと12 Assetで`ownership_conflict`が記録された。Galleryの通常Reloadは完了扱いだったが、保持中のSTACK管理セッションには送信前の単独Asset情報が残っていた。Recentにも旧所属の照会が残り、別日のSTACK管理へ入った後は保持セッションが別日素材へ置き換わった。後半のresolve成功だけではX除外状態の正常化を示さないため、先行するGallery status応答も照合した。

### 原因と修正

保持セッションの所有者解決はCoverのAsset IDを中心に行い、Cover以外のメンバーについて新しい所属先を特定できなかった。そこで、表示中のAsset、Coverの`stackMemberIds`、共有の受理済みSTACK snapshotの順に所有者を解決し、受理済みsnapshotがAssetの一意な所属を示す場合だけ採用する。新しい応答が旧メンバーを別STACKまたは単独Assetとして示し、旧STACKのreplacement snapshotが応答にない場合は旧snapshotを無効化する。所属を確定できない、または複数候補が残る場合は従来の安全判定を維持する。

STACK送信後のGallery再取得予約をビュー別に保持するよう変更した。通常のビュー読込が送信後に開始されればその読込で予約を満たし、それ以外は既存Reload経路を使う。送信前に開始した同一ビューの読込はwrite revisionが一致しないため予約を消費しない。未表示のRecent、Favorites、Albums、Calendar各ビューの予約は、そのビューを開いたときに消費する。Export経由で戻る場合も予約を保持する。既存の選択・日付・スクロール復元とD/S/Q/V入口ガードは維持した。

### 検証

修正前はCalendar Reload後にも旧単独Assetと新STACKの競合が残る回帰テストが失敗し、修正後は通過した。Calendarの日付詳細からの再入場、Recentなどのキャッシュ再取得、別日への移動と復帰、送信前の遅延応答、送信完了とReloadの競合、矛盾した所属情報の無効化も回帰確認した。

Frontend全体テストは2,928件成功・2件スキップ。監査修正後の関連テストは374件成功。Backend全体は1,127件と322 subtestsが成功した。TypeScriptチェック、本番build、`git diff --check`も成功し、buildには既存の500 kB超chunk警告が残った。利用者報告によるNAS・Firefox実機確認はPASS。これは利用者の実機確認であり、Codexは今回の作業でNASやFirefoxを操作していない。

## Gallery現像対象外（X）Phase 1〜2 完了時の記録（2026-10-13）

### 実装経過

- **Phase 1 — Backend：** 既存SQLiteのschema v5へ`development_exclusions`を追加し、STACK単位・単独Asset単位の永続状態と、個別GET／PUT／DELETEおよび最大100件のstatus取得APIを実装した。COVERとメンバー集合を保存し、GalleryのSTACK snapshotで構成変更・確定解体・単独AssetのSTACK編入を確認する。取得失敗や不完全・曖昧なsnapshotから誤った失効は行わない。
- **Phase 2 — Gallery：** Xキーによる登録・解除、除外中のサムネイルとファイル名の減光、既存Export Queueの解除連携を実装した。STACKは1対象として全メンバーをQueue確認・解除し、必要な解除がすべて成功した場合だけ除外を保存する。`waiting`／`encoding`／`registering`や処理中・canonical状態不明のQueueを操作しない。Recipe・History・Immich写真・STACKは変更しない。
- 複数選択時の世代・状態確認競合を修正し、現在の選択を参照する経路と、混在状態では未除外対象だけを登録する方向判定を確認した。
- 単独写真のX操作が状態不明で止まる再現に対し、既存Backend／FrontendログへSTACK snapshot解析診断と状態取得・mutation診断を追加し、実機ログを採取した。
- Phase 2完了時点では、Phase 3の暗室・STACK管理・Queue投入・没入プレビューへの入口制限は未実装だった。その後の完了状況は、次のPhase 3記録に示す。

### 原因調査

実機ログ`genzoroom-all-logs-20261013T101617Z.json`では、Immichの`GET /stacks`から716件を取得し、711件が正常、5件が`primary_not_member`として不完全だった。5件についてSTACK ID、COVER ID、メンバーIDは取得され、重複STACK IDやメンバー所属競合は記録されていない。単独写真のX登録は`configuration_unknown`で止まり、正常STACKの登録・解除は成功していた。

利用者はImmichのごみ箱から少なくとも1件を一時復元し、そのAssetが含まれるSTACK構成が残っていることを確認した。また、ごみ箱内に見えるSTACKが5件あると報告した。ただし、5件すべてについて個別のAPI状態やごみ箱内Assetとの対応を確証したわけではない。

Immich v3.3.1のSTACK repositoryではSTACKレコードの取得とメンバーAssetの取得条件が異なり、後者は削除状態・表示条件で絞られる。したがって、ごみ箱内Assetなどがメンバー配列から除外され、`primaryAssetId`が`assets`に含まれない応答が起こり得る。この形は記録された5件の`primary_not_member`と整合するが、ログだけから各不完全STACKの原因を断定はしない。

### 修正と検証

従来はsnapshot全体の`complete=false`だけで、既知STACKと無関係な単独Assetも一律`unknown`となっていた。`membership_identifiable`を追加してsnapshot全体の完全性とAsset所属の識別可能性を分離した。所属関係を識別できる場合、正常STACKのメンバーは`stacked`、不完全STACKのCOVER・既知メンバーは`unknown`として保護し、それらに関係しないAssetは`single`と判定する。IDやメンバー情報が不十分な場合の安全側判定、不完全STACKを正常扱いしない規則、STACK除外の失効判定は維持した。個別Assetへの追加API呼び出しも加えていない。

716件中711件正常・5件がCOVER不在の不完全STACKという再現テストを追加し、無関係な単独Assetの登録と不完全STACK関連Assetの保護を確認した。Codexによる最終Backend全体テストは**1,123 passed、322 subtests passed**。これは自動テストの結果であり、実機確認とは別である。

利用者によるNAS・Immich実機確認では、Galleryの警告表示が消え、X操作も期待どおりに動作した。これは利用者の実機確認であり、Codexは今回NAS・ブラウザー確認を行っていない。

## Gallery現像対象外（X）Phase 3・横断監査完了（2026-10-13）

### Phase 3の入口制御

GalleryのX除外対象を、暗室（D）、STACK管理（S）、Export Queue追加（Q）、没入プレビュー（V・ダブルクリック）の処理対象から外した。没入プレビューは初期対象の選別に加え、前後移動にも除外対象を含まない閲覧リストを使う。混在選択では、除外状態が確認済みで未除外の対象だけを既存機能へ渡し、全件が除外または未確認なら遷移・登録を行わない。既存の除外状態APIとFrontend状態管理を利用し、新しい永続管理機構やBackend APIは追加していない。暗室Filmstrip内のセッション限定X除外は独立している。

### 横断静的監査と修正

初回の横断監査結果は**High 0件、Medium 4件、Low 0件**だった。次の4件を既存の状態管理・セッション管理・Queue APIを使って修正した。

1. **M1 — STACK管理セッションへの古いAsset再混入：** 再入場時にAsset IDだけでなくSTACK ID・COVER・メンバー集合を比較する。構成変更時は既存generationを更新してドラフトを再生成し、順序だけの変更や構成不変のタブ往復ではドラフトを維持する。
2. **M2 — Queue解除と除外登録の構成不一致：** Queue確認・解除に使った期待COVERとメンバー集合をSTACK除外PUTでBackendへ渡し、最新Immich構成と合わなければHTTP 409で登録を拒否する。既に解除したQueueは復元しない。
3. **M3 — STACKから開いた暗室の再開：** 展開済みメンバーを共有STACK snapshotの所属情報で判定し、許可された展開済みAssetを使って再開する。GalleryのSTACK初期選択処理を再適用しないため、Gallery選択解除後も未除外STACKの暗室を再開できる。
4. **M4 — 保持セッションの状態照会不足：** 最新の暗室再開対象と保持済みSTACK管理セッションを除外状態照会へ含め、別GalleryタブやExport画面からの再入場でも古い状態を使わない。

### 検証

Codexによる修正後の自動検証では、Frontend関連7ファイル**360件成功**、Backend関連5ファイル**329件成功**。TypeScriptチェック、本番ビルド、Python構文チェック、`git diff --check`も成功した。本番ビルドには既存の500 kB超チャンク警告があった。これらは自動検証の結果であり、実機確認とは別である。

利用者によるNAS・Immich・ブラウザー実機確認では、Phase 3の各入口が期待どおり動作し、横断監査修正版も問題なさそうとの報告があった。STACK暗室の再開が一時失敗したとの報告は、修正版コンテナが未デプロイだったためで、現行コードの不具合とは扱わない。Codexはこの記録のための実機確認を行っていない。

## 出力管理入場時の現像済みサムネイルURL更新（2026-10-13）

### 発生状況と原因

暗室でRecipeを変更・保存した後、GalleryではReloadで新しい現像済みサムネイルを確認できても、出力管理では以前の画像が表示される場合があった。ブラウザーページ全体を再読み込みすると更新される一方、出力管理タブの表示状態は維持されない。

出力管理のカードは`thumbnailUrl(asset)`を使っており、画像の再取得に使う`refreshKey`をURLへ渡していなかった。同じAssetのURLが維持され、古いブラウザーキャッシュが再利用され得た。

### 修正

- 他タブから出力管理へ入るたび、Export専用の`exportThumbnailRevision`を更新し、既存の`thumbnailUrl(asset, true, refreshKey)`を介して`view`クエリを変える。
- 通常カードとStackグループ内カードの両方へrevisionを適用する。同じタブ内の選択、Q/W、Undo、Queue更新では変えない。
- Gallery側の`thumbnailViewRevision`とは独立させた。Queue取得、Queue内容、選択・Arm状態、Stack所属、スクロール位置、Backendの生成・キャッシュ・60秒デバウンスは変更しない。URLの再取得で既存キャッシュを読む仕組みであり、Recipeを再現像しない。

### 検証

関連Frontendテスト47件、TypeScriptチェック、本番ビルドが成功し、`git diff --check`も成功した。buildには既存の500 kB超chunk size警告が残る。これらは自動検証結果である。

Push後のGitHub限定レビューで変更範囲とコードを確認した。今回のURL更新後に現像済みサムネイルが実機で再取得・表示されることを利用者が新たに確認した記録はないため、実機確認済みとは扱わない。過去のNAS・Immichでのサムネイル生成・画質確認とは区別する。

## 没入プレビュー Phase 1〜4・Focused Audit Low修正（2026-10-13）

### 実装

- **Phase 1 — 共通Viewer・画像取得：** `ImmersivePreview`と`GET /assets/{id}/immersive-preview`を追加した。非デフォルトRecipeが保存され、現像済みJPEGキャッシュを読める場合はそれを返し、それ以外はImmich Previewへfallbackする。GETから生成予約・現像実行は行わない。Viewerの閲覧一覧と画像モードは起動時に固定する。
- **Phase 2 — Gallery：** Recent、Favorites、Album詳細、Calendar日付詳細からVキーまたはカードのダブルクリックで開く。Vでは未選択なら開かず、単一選択なら表示中の一覧、複数選択なら表示順の選択写真だけを閲覧する。ダブルクリックの開始位置はクリックした写真。複数選択中の通常クリックは400ms保留し、Shift／Primary操作は即時。Spaceは現在写真だけの選択切替、Qは既存条件に従う現在写真だけのQueue操作。
- **Phase 3 — 出力管理・暗室：** 出力管理ではQueueのflatten済み表示順をスナップショットとしてV／ダブルクリックで開く。Spaceによる選択は行わず、Qは表示写真1枚のQueue解除、Wは同じ写真1枚のArm切替を行い、既存のガード・エラー処理・Undo経路を共有する。暗室のViewer focus modeはFからVへ移行した。FavoritesタブのFは維持する。
- **Phase 4 — STACK管理：** 候補グループの空白ダブルクリックはCoverから、グループ内写真のダブルクリックはその写真から始め、いずれもグループ内全写真を表示する。候補外写真はGalleryと同じV／ダブルクリック選択ルールを使う。STACKモードは閲覧専用で、選択／Q／W操作を表示・実行しない。補正済み表示スイッチは起動時に固定し、OFFでは現像済みキャッシュを使わない既存`preview` APIを選ぶ。

共通Viewerは写真をアスペクト比を保ってFit表示し、左右20%クリックと←／→で境界内移動する。上下ツールバーは常時表示し、V／Esc／Xで閉じる。現像済み写真の「現」バッジ、ファイル名省略、OS別ヘッダー配置を使う。画像クリックによる選択やQueue変更は行わず、状態の所有は各親画面に残す。Viewer表示中は登録済みアプリ用ショートカットの背後への伝播を抑止する。

### 実機で見つかった表示・操作修正

利用者の実機確認で、現像済みJPEGが没入PVで上下に切れること、Windows/LinuxのX位置、バッジとファイル名の間隔、および写真クリック時の暗転が報告され、Fit用Grid計算とヘッダー配置を修正した。ツールバー切替を削除して常時表示にし、写真表示領域の左右20%クリックを前後移動にした。これらは利用者による実機確認で見つかった問題と、その後のコード修正であり、今回の文書更新時にCodexがブラウザー・NASで再確認したものではない。

STACK候補グループのヘッダーでは、`.stack-group-indicators`全体を除外していたため、判定バッジの左右の空白もダブルクリック対象外になっていた。除外対象を実際の`.stack-evidence`バッジと操作部品に限定し、バッジ左右の空白ではCoverから開き、バッジ本体・削除／追加ボタンでは起動しないようにした。

### Focused Static AuditとLow 4修正

Phase 1〜4の初回Focused Static Auditは**High 0 / Medium 0 / Low 4**。Frontend 583件、Backend 28件の自動テストは成功した。Lowの限定差分レビュー後、次の4点を修正した。

1. Gallery／出力管理Viewerで、Viewerが使わない登録済みキーが背後へ伝播し、テンキーの＋／－などを実行し得た。共通shortcut registryに基づきViewer表示中のアプリ用キー処理を止め、キーリピートも対象とした。Viewerのモード別操作と入力欄・ダイアログ等のガードは維持した。
2. 出力管理のAssetDetail経路とViewer用Asset変換でGenzoRoom出力判定が欠落していた。既存のタグ判定を同じAssetDetail応答から渡し、未知状態をfalseに誤変換しないようにした。追加の個別タグ検索は行わない。
3. Gallery／出力管理の400ms保留クリックは、Settings表示または画面非アクティブ後に遅れて選択を変更する余地があった。両状態への遷移時に取消し、タイマー実行時にも現在の操作可否を確認する。
4. 560px以下でヘッダーの左右Grid列が内容幅により非対称になり、ファイル名中央がずれていた。狭幅時のみ左右対称列にし、通常幅、ellipsis、バッジ間隔を維持した。

Push後に実施された限定差分レビューでは、このLow 4件の修正成立が確認された。監査後に全体横断監査を再実施したという記録ではない。

### 検証

- 初回Focused Auditの関連Frontendテスト：**583件成功**。関連Backendテスト：**28件成功**。
- Low修正後の関連Frontendテスト：**601件成功**。Backend：**79 passed、72 subtests passed**。
- TypeScriptチェックとFrontend本番ビルドは成功。buildには既存の500 kB超chunk警告がある。`git diff --check`も成功。
- 自動テストと静的差分レビューは、利用者による実ブラウザー／NAS確認とは区別する。文書更新時点でCodexは実ブラウザー・NAS実機確認を行っていない。

## 余白クリックによる選択解除の改善（2026-10-12）

### 実装経過

- Galleryは当初`.photo-grid`自身のクリックで選択を解除していたが、最終行より下の余白を受け取れなかったため、判定をToolbarより下の`.home-content`へ移した。
- 出力管理も同じ写真表示領域の判定を利用し、既存の`useExportManagement.clear()`で選択だけを解除する。
- STACK管理は下段の`.stack-unmatched-frame`だけに判定を追加し、上段のSTACK候補領域には適用しない。
- 選択解除には既存の選択管理処理を使い、新しい選択stateは追加していない。

### 検証

各段階の関連Frontendテストは成功した。最終追加段階ではGallery 62件、出力管理33件、STACK管理114件が成功した。TypeScriptチェック、production build、`git diff --check`も成功した。buildには既存の500 kB超chunk size警告が残る。

利用者はNAS・実ブラウザーで動作を確認した。これは利用者による実機確認であり、Codexによる自動テストとは区別する。

### Focused Static Audit

Gallery・出力管理・STACK候補外のクリックイベント、選択管理、既存操作との干渉を静的に確認した。High 0件、Medium 0件、Low 0件で、具体的なFindingはなかった。この監査ではテスト・build・typecheckを再実行しておらず、実ブラウザーでの座標・レイアウト確認とも区別する。

## 現像済みサムネイル機能の実装・監査完了（2026-10-12）

### 実装経過

- **Phase 1 — Thumbnail Generator：** Immich Previewと保存済みRecipeから、最大辺1024pxの現像済みJPEGを生成する独立Backend処理を追加した。
- **Phase 2 — Backend予約・キャッシュ・API：** 60秒デバウンスとAsset ID単位の逐次キュー、1GiBのディスクキャッシュ、現像済みサムネイルの取得・即時予約APIを実装した。
- **Phase 3 — Frontend統合：** Gallery写真一覧、暗室Filmstrip、出力管理で現像済みサムネイルを利用し、STACK管理に表示切り替えを追加した。
- STACK管理の表示切り替えは、状態がわかる「補正済み表示」ON/OFFスイッチへ改善した。
- 共通ショートカットレジストリにBackslashを登録し、STACK管理では押すたびに表示を切り替える。暗室では既存どおり押している間だけ補正前を表示する。

### 利用者によるNAS・Immich実機確認

利用者は保存済みRecipeを適用したサムネイルの生成・表示に成功し、GenzoRoom生成サムネイルの画質を確認した。特定の写真での実測例は約350KBであり、固定サイズや平均値を示すものではない。暗室とSTACK管理のBackslash操作、およびSTACK管理の表示切り替えも正常に動作することを確認した。これは利用者による実機確認であり、Codexによるテストとは別である。

### 初回静的横断監査と指摘修正

初回の静的横断監査は**High 0 / Medium 1 / Low 1**だった。Mediumは、デフォルトRecipeへの復帰時にキャッシュ削除が失敗すると旧画像が配信される問題。Lowは、Historyだけを変更した暗室セッションの離脱時にも即時生成を予約する問題だった。

両方を修正した。GET配信前に保存済みcurrent Recipeを確認し、デフォルトRecipeまたは未登録なら残存キャッシュを配信しない。暗室離脱時の即時生成対象を、セッション中にcurrent Recipeが変更されたAssetだけに限定した。History保存・compactionとFilmstrip移動時の保存・予約経路は維持している。

この修正箇所の限定再確認では**High 0 / Medium 0 / Low 0**。初回の全体横断監査と限定再確認は別の確認段階である。

### Codexによる自動テストとチェック

各段階で報告されたテスト結果は次のとおり。値は各段階の個別結果であり、重複分を合算していない。

- Phase 1：関連Backendテスト103件・186 subtests成功。
- Phase 2：新規テスト28件成功、関連テスト355件・56 subtests成功。
- Phase 3：Frontend 2,721件成功・2件skip。
- STACK管理UI改善：関連テスト118件成功。
- STACK管理Backslash追加：関連テスト147件成功。
- 最終監査指摘の修正：Backend 41件・41 subtests成功、Frontend 170件成功。

該当段階でのtypecheck、production build、Python構文チェック、`git diff --check`も成功した。Frontend buildには既存の500 kB超chunk size警告が残る。これらはCodexの自動検証記録であり、利用者によるNAS・Immich実機確認とは区別する。

## MPO形式JPEGのExport対応完了（v0.1.3、2026-10-11）

### 発生状況

古いデジタルカメラで撮影されたJPEG画像が、暗室では表示・色編集できる一方、Exportでは`not_jpeg`で失敗した。構造化JSONログの比較では、ImmichからのAsset詳細取得とoriginal取得は成功し、Exportはencoding段階で停止していた。暗室にはブラウザーの画像デコーダーを使う経路があり、ExportはBackendのPillowを使うため、形式判定が異なる。暗室ログには実際にoriginalとpreviewのどちらを使用したかが記録されておらず、編集元は確定していない。

### 原因調査

提供された元画像をPillow 12.3.0で検証すると、通常のJPEGではなく2フレームを持つ有効なMPO形式として認識された。現行codecへ入力するとExportログと同じ`not_jpeg`を再現した。修正前の`decode_jpeg()`は`image.format == "JPEG"`だけを許可し、画素デコード前にMPOを拒否していた。この形式判定が直接原因であり、ROマウントによる書き込み失敗ではなかった。

### 修正内容

- `backend/jpeg_codec.py`でPillowが認識する`JPEG`と有効な`MPO`を許可し、`decode_jpeg()`と`inspect_jpeg_source()`の判定を統一。MPOではフレーム0を明示的に選択する。
- 既存の画像サイズ制限、ICC検証、EXIF方向補正、色空間処理を維持。JPEG以外の形式と破損した主フレームは引き続き拒否する。
- 出力は追加フレームやMPF情報を含まない単一のsRGB JPEGとし、元画像のバイト列は変更しない。元写真はリポジトリのテストfixtureに追加していない。

### 検証・監査

**実ファイルによる検証**では、従来の`not_jpeg`を再現し、修正後に第一フレームをデコードした。入力バイト列の不変性を確認し、3648×2736の単一sRGB JPEGを生成してMPF情報が含まれないことを確認した。

**NAS / Immich実機確認**は利用者が実際の写真で行い、Export成功、出力JPEGのImmich書き込み可能な管理ライブラリへの登録、RO外部ライブラリの元画像とのStack構築成功を確認した。これは利用者による確認であり、Codexが実機操作したものではない。

**初回完成監査**の全テストはFrontend 2,691 passed / 2 skipped、Backend 1,002 passed / 322 subtests passed。Frontend typecheckとproduction build、Backend `compileall`、`git diff --check`も成功した。監査FindingはHigh 0 / Medium 0 / Low 1。LowはMPO fixtureの2フレームが同じ寸法で、`inspect_jpeg_source()`による第二フレーム誤選択を検出できない点だった。

Low修正ではfixtureを第一フレーム11×7、第二フレーム5×3に分け、寸法assertを追加した。Focused Testsは13 passed / 19 subtests passed。第二フレームを選択する仮の誤実装で寸法assertが失敗することも確認し、指摘を解消した。修正範囲はテストfixtureのみでcodec本体は変更しておらず、この修正後に全テストは再実行していない。

Windows sandboxでのイベントループ初期化停止は、制限外実行で正常完走し、今回のMPO修正が原因ではないことを確認した。FrontendにはReact `act()`等の警告、buildには既存の500 kB超チャンク警告があった。実WebGPU環境を必要とする比較テスト2件はskipされた。

### RO外部ライブラリ

今回のExport失敗原因はMPO形式の判定であり、ROマウントではなかった。利用者による修正後のNAS / Immich実機確認では、RO外部ライブラリを出力元としても、現行の登録処理でJPEGをImmich管理ライブラリへ登録し、元AssetとのStack構築が成立した。元ライブラリへの書き込みや外部ライブラリ専用の新規実装は必要なかった。

## 出力管理の取得不能Asset除外・監査修正完了（2026-10-11）

### 発生状況

過去に出力失敗した写真がImmichの鍵付きフォルダへ移動され、GenzoRoomの永続Queueには`failed`記録が残っていた。出力管理の個別Asset詳細取得がHTTP 400になると、取得できる写真も含めてタブ全体が読み込み失敗になっていた。利用者によるNAS / Immich実機確認では、写真を鍵付きフォルダから戻して出力管理タブへ再入場すると、詳細が再取得されて表示へ復帰することを確認した。

### 修正内容

取得に成功したAssetだけをQueue順で表示し、選択・Arm・Queue除外・Start・Retry・Retry優先判定の対象とする。取得不能AssetはUIから除外し、永続Queue・Recipe・Historyには干渉しない。非表示の`failed`はRetry優先を発動しないため、表示可能な写真の出力を妨げない。タブ再入場で詳細を再取得し、取得可能になったAssetは元のQueue状態で再表示する。

再入場後のmetadata取得中とStack情報の一括取得失敗時はQueue ID・statusを基準に選択・Arm・Arm Undo記録を保持し、Arm Undoを消費しない。取得成功が確定した時点で、選択・Arm・Undo対象を成功Assetに整理する。既存のOne-shot Undo、Abort、generation、Stack結合、canonical制御は維持する。

### 検証・監査

初回実装時のFrontend全テストは2,687件成功・2件skip、Backendは997件成功・322 subtests成功。NAS / Immich実機で取得不能Assetの非表示と、取得可能になった後の復帰を確認した。

初回Focused Auditは**High 0 / Medium 2 / Low 0**。Medium ①はmetadata再取得中にArm Undo記録を消費する問題、Medium ②はStack取得失敗時に選択・Arm・Undo記録が失われる問題だった。2件を修正し、Focused Tests 5ファイル・94件成功、TypeScriptチェック、production build、`git diff --check`も成功した。buildでは既存の500 kB超チャンク警告が出た。

最終限定再監査は静的確認で2件の修正成立を確認し、**High 0 / Medium 0 / Low 0**。Medium修正後のNAS / Immich実機再確認は未実施。最終再監査では全テストとbuildを再実行していない。

### 別課題

外部ライブラリのROマウント環境における現像出力失敗への対応は、この修正と分離する。現像結果をImmich管理ライブラリへ登録し、元のStackに追加する方式は今後検討する。ROマウントが過去の出力失敗の直接原因であるとは断定しない。

## Gallery Reload機能の完了記録（v0.1.2、2026-10-11）

Immich側の変更を反映するにはブラウザー全体のReloadが必要だったが、それではGalleryの閲覧位置やSPA状態が失われるため、現在表示中のGalleryだけを再取得するmanual Reloadを追加した。対象はRecent、Favorites、Album一覧／詳細、Calendar年／月／日付詳細。Toolbar最左に日本語「リロード」／英語`Reload`を置く。shortcut explanation設定がONの場合、Tooltipとaria-labelに「写真を再読み込み [Shift+R]」／`Refresh photos [Shift+R]`を表示する。`Shift+R`で実行し、`R`はRecent、Ctrl+R／Command+Rはブラウザー標準Reloadのまま。STACK管理、出力管理、Anshitsuは対象外。

Refreshは現在のtab、Album／Calendar階層、年・月・選択日、filter、Thumbnail size、Recent表示件数、存在する写真Selection、scroll位置、他タブのSPA状態を維持する。Selectionは通常取得と同じ`retainAvailable()`で現存Assetを残す。Refresh中も正常表示済みのデータを保ち、失敗時も写真表示を可能な限り維持する。ビュー遷移用のscroll restorationは開始しない。狭幅ToolbarではReloadとSelection groupの間で折り返し、Selection groupの内容幅を保つ。

Recent、Favorites、Album一覧／詳細、Calendar heatmap／日付の既存取得経路を再利用する。manual ReloadだけFavorites／Album一覧の通常cacheをバイパスする。同期operation lockで重複実行を拒み、view context、AbortController、request／operation ownershipで古い応答を拒否する。Calendar日付詳細Reloadはday assets、minimum year、隣接日Heatmapを同一Refresh operationとして管理し、すべての取得が終わるまでbusyを維持する。Calendar Reloadは共有generationを進めて隣接日cacheを失効させるが、通常navigationではgenerationを進めない。通常の隣接日取得とmanual Reloadには別々のrequest ownerを割り当て、current ownerだけがdate候補を更新する。manual Reload開始前の通常取得はAbortし、Abortを無視する遅延応答もowner／date／generation確認で拒否する。Reload成功後・失敗後に旧取得が遅れて完了する競合を別Promiseで再現する回帰テストを追加した。

監査履歴: 初回focused auditはHigh 0／Medium 3／Low 1。MediumはCalendar親Reload後の隣接日cache失効、日付詳細Reloadの隣接Heatmap operation管理、狭幅Toolbarの折り返し不足。Lowは最終UIと文書のボタン名称・説明の不一致だった。Medium 3件の修正後の再監査では、通常の隣接日取得がmanual Reload結果を上書きするMedium 1件を追加確認した。request owner、旧取得のAbortとowner check、成功・失敗後の遅延応答テストを追加して修正した。最終focused re-auditでは前回Mediumの修正を確認し、High 0／Medium 0／Low 0、Release blockerなし。

利用者から、実ブラウザーでReloadを操作して動作上問題がないこと、ボタン表示が文字「リロード」／`Reload`であることを確認したとの報告を受けた。狭幅layoutについて全viewportの厳密な実測確認までは行っていない。

検証記録: 初回実装時はFrontend 2,671 tests成功・2 skip、Backend 997 testsと322 subtests成功。focused修正段階では関連Frontend 19 files／464 tests成功、Calendar Reload最終関連テストは82 tests成功。`npx tsc --noEmit`、production build、`git diff --check`も成功した。buildには500 kB超chunkのwarningがある。

## 暗室フィルムストリップ写真除外・復帰の完了記録（2026-10-10）

サムネイル左上の独立した×ボタンと中央ショートカットレジストリの`X`で、暗室セッション内だけ写真を除外できるようにした。最後の1枚は除外不可。アクティブ写真の除外後は次の写真（末尾なら前の写真）へ移動し、非アクティブ写真の除外では表示を維持する。既存`save()`の`ok && clean`を確認してから確定し、PUT中の追加編集も保存する。保存失敗・結果不明では除外せず、復旧可能な状態を保持する。写真とSQLiteの編集レコードは削除せず、Recipe・History・カーソルを保持する。除外自体はExport Queue・STACKの操作を発生させない。

直前の除外は`Primary+Z`で1回だけ元の順序へ復帰できる。アクティブ写真のUndoはその写真を表示し、非アクティブ写真のUndoは現在の表示を維持するよう改善した。次の編集、手動移動、次の除外、Gallery復帰でUndo権を破棄する。除外による自動移動では破棄しない。除外Undoは編集Historyと分離し、同一キーハンドラーで優先判定するため、編集Undoと二重実行されない。

初回Focused Auditは**High 0 / Medium 1 / Low 1**。Mediumは非アクティブUndo後に`retainForUndo()`の保持予約が残り、後の通常移動で古い状態を再利用する問題で、予約をアクティブ写真への即時復帰だけに限定した。外部更新後の通常移動で最新Recipe・HistoryをGETし、最新revisionで保存する回帰テストを追加した。LowはReset allによるUndo失効テストが先に別の編集を行い、Historyメニューと混同するセレクターを使用していた不備。編集済みGET fixtureからDevelopのReset allを直接操作し、単独で除外Undoが失効し、その後の`Primary+Z`が編集Historyを戻してRecipeとカーソル位置を復元するテストへ修正した。

最終限定確認は、この2件と直接関連する保存・遷移・Undo・セッション条件を対象に実施し、両修正の成立を確認した。新規Findingは**High 0 / Medium 0 / Low 0**。全面的な再監査ではない。

監査指摘修正時の関連Frontendテストは7ファイル・401件成功。今回の限定再確認では`AnshitsuPersistence`、`Filmstrip`、`useAssetEdits`、`editShortcuts`の4ファイル・215件成功。Frontend typecheck（`tsc --noEmit`）とproduction build、`git diff --check`も成功した。buildには既存の500 kB超チャンク警告が残る。

ユーザーから本機能のブラウザー実機確認は「確認済み・問題なし」と報告を受けた。個別ケースの内訳および監査指摘修正後の再確認時点は特定していない。Codexによる確認はコードと自動テストに限定し、ブラウザー・NAS・Immich実機操作は実施していない。

## STACKゴミ箱予約・監査修正の完了記録（2026-10-09）

`feature/stack-trash`で、既存STACKの非COVER・非RAWメンバーを右クリックからゴミ箱予約し、既存の「Immichへ送信」でSTACK編集と一括反映する機能を実装した。通常のメニュー項目で予約・取消しを行い、予約中はサムネイル中央にゴミ箱アイコンを表示する。予約・取消しは既存の1ステップUndoに含める。PurgeはSTACK所属を編集する操作であり、AssetをImmichのゴミ箱へ移す操作とは区別する。取得時点の元STACKメンバーだけが予約でき、Add・D&Dで追加した素材、元COVER、現在COVER、RAWは予約不可とした。

送信は旧STACK解除、予約対象を除く残存メンバーの再作成、最新状態の検証、`DELETE /assets`の`force: false`による通常ゴミ箱移動の順で行う。残存1枚ならSTACKを作成しない。STACK更新に失敗すればゴミ箱へ進まず、ゴミ箱だけが失敗しても成功済みSTACKを巻き戻さない。成功済み候補は再送対象に戻さず、STACK結果とゴミ箱結果を分けて表示する。

実機確認と自動テストは区別する。利用者から、NAS・Immichでの正常ケース確認日は**2026-10-09**との報告を受けた。確認した枚数別ケースの内訳は、この記録では特定していない。共有された実機診断ログでは旧STACK解除HTTP 204、新STACK作成HTTP 201、検証HTTP 200／`matches: true`まで成功し、ゴミ箱前の全体判定で停止する問題を確認した。正常676件に対して無関係な不正STACK 3件・隔離メンバー6件が存在したためで、検証を操作対象STACK・残存／予約Assetへの関連性と非所属の証明可能性に限定した。関連する不整合や所属を証明できない破損データは引き続き停止する。Homeの異常シングルSTACK検出と赤い「1」表示は変更していない。今回CodexからNAS・Immich実機操作は行っていない。

初回Focused Auditの**High 2 / Medium 3 / Low 2**を段階的に修正した。Highは、旧STACK解除後の再作成失敗で失われた元COVER保護を`trashSource`としてMANUAL再送分類から分離して保持する修正と、解除前に最新Asset詳細の`stack.primaryAssetId`を照合する修正。Mediumは、取得時点の所属を基準に追加素材の予約を拒否する修正、ゴミ箱だけの失敗が独立した確定失敗候補の再送を妨げない修正、ゴミ箱APIの5xxを結果不明と分類する修正。Lowは、予約中のUI・D&DとReducerの制約を揃え、許可される未所属素材の追加を維持する修正と、元COVER保護・Undo・再送・混在バッチなど複合経路テストの補強だった。

最終Focused Auditは**High 0 / Medium 0 / Low 2**。残ったLowは、キーボードでHomeタブを切り替えた際にbody Portalのゴミ箱メニューが残る問題と、Backendテストが単一STACK GETにもAsset形式を返し、失敗注入のAsset取得回数がDiagnosticsに依存する問題だった。今回、非アクティブ時のPortal描画抑止とメニュー状態破棄、キーボードタブ切替・復帰・Escape／外側クリックの回帰テスト、APIルート別GETモック、Asset詳細だけのカウント、debug正常時の作成後検証成功、Diagnostics off/debugで同じ失敗注入結果となるテストを追加・修正した。本番Backendの処理は変更していない。

既知の制約として、最後の検証からImmich書き込みまでの外部並行変更を原子的には防止できない。自動再送・分散ロック・削除rollbackは導入していない。実機ブラウザーでのキーボードタブ切替と復帰時の表示、および今回修正後のNAS・Immich動作は利用者側の確認対象とする。

今回の自動検証はFrontend関連6ファイル**174 passed**、指定Windows `.venv`のPython 3.14.5でBackend STACK関連**106 passed**。Frontend typecheck、production build、`git diff --check`も成功した。元COVERの再編集・Undo・再送、最新COVER照合、追加素材の予約拒否、独立候補の再送、5xx／timeoutの結果分類を含む既存回帰テストを再実行した。初回のサンドボックス実行ではVitest一時ファイルのENOENTとBackendテストの停止が発生し、同じテストコマンドを通常環境で再実行して成功を確認した。buildの既存500 kB超chunk警告は残る。実機確認とは別の検証結果であり、新しい網羅監査を実施したという意味ではない。

## Gallery STACK暗室送り Phase 1〜5 完了・最終横断監査（2026-10-08）

GalleryのRecent / Albums / Calendar / Favoritesで、STACKのCOVERカードからSTACK内の複数Assetを暗室へ送る機能を実装した。初期選択はGenzoRoom未出力のNon-RAW全件で、対象がなければRAW全件へフォールバックする。GenzoRoom出力済みAssetは候補から除外し、タグ判定の不明・矛盾やSTACK情報の不整合時には不完全な候補を利用可能として扱わない。代表カードの表示は維持する。

Phase 1ではGallery応答へSTACK全メンバー情報とAsset単位のタグ状態を追加した。Phase 2では初期選択、形式別全件切替、手動選択を実装し、STACK IDごとの手動選択だけをsessionStorageへ保持する。Phase 3では選択Assetを既存の暗室遷移へ展開し、未選択時の直前暗室への復帰を維持した。Phase 4では形式バッジを選択スイッチ化した。Phase 5では右クリックメニュー上段に個別暗室送り選択、下段にAssetごとの出力Q登録・解除を追加した。手動選択は4タブで共有され、メニュー操作だけでは暗室へ遷移しない。単独Assetの暗室送りは従来どおりそのAssetを使い、単独Assetの右クリックは標準メニューを維持する。RAW素材を暗室で表示できることはRAW現像対応を意味しない。RAW現像は未実装である。

最初の横断監査はHigh 1 / Medium 6 / Low 1だった。修正AではF01・F02として同一Asset IDのタグ矛盾を候補情報の利用不可として扱い、Galleryカード表示を保つとともに、タブ間で共有するSTACK snapshotで古い表示データが新しい手動選択を削除しないようにした。修正BではF03〜F06としてQueue登録・解除条件、編集状態取得の失敗・timeout、canonical Queueの復旧制御を修正した。修正CではF07・F08としてメニュー内容のサイズ変化に応じた再配置と初期フォーカスを整えた。最終再監査ではR01〜R03を検出し、未終了Gallery要求の管理、可視化後の初期フォーカス、フォーカス中の項目がdisabled化または削除された際の退避を修正した。

DeveloperLogsPanelのテスト間干渉は、共有Frontendログsingletonを利用するテストのBroadcastChannelがVitest worker間で状態を伝播する経路を確認し、テスト環境内で分離した。本番ログの収集・保持・通知仕様は変更していない。STACKメニューのホバー強調とチェックボックス明度も調整した。

最終Frontend検証は**119ファイル、2,534件成功、既存2件skip、失敗0**。Backendは直近の最終再監査で**860件成功**した。最後のR01〜R03修正ではBackendを変更していない。Frontendの型チェック・buildと`git diff --check`も最終修正サイクルで成功し、buildには既存の大容量chunk警告が残る。自動テストとコード確認は完了した。NASへのdeployや今回の最終修正後のブラウザー実機確認、特殊な異常系の実機確認を行ったとは記録しない。ユーザー側の実機確認はこの自動検証とは別である。最終限定再確認では新たなHigh相当の問題はなく、Phase 1〜5の終了条件を満たした。

## Home自動タグ修復のStackメンバー対応・実機確認（2026-10-08）

Immichへ出力した`-Genzo01.jpg`で、初回登録後に撮影情報・画像寸法の表示不備とGenzoRoomタグ欠落が確認された。JPEG現物の検証では、元画像、Genzo01、Genzo02はいずれも3072×4080で、Genzo01とGenzo02はデコード後の画素が完全一致した。Immichでメタデータ抽出とサムネイル再生成を行うと、Genzo01の画像表示と撮影情報は正常化したが、タグは復旧しなかった。画像表示・メタデータ不備とタグ欠落の因果関係、および初回Export登録時にタグが欠落した原因は確定していない。

原因は、従来のHome-time tag repairがHome APIから渡される代表Assetだけを候補収集し、`stackMembers`内の非COVERメンバーを走査していなかったことだった。Genzo02がCOVERかつタグ付き、Genzo01が非COVERかつタグなしの状態では、Genzo01が修復対象にならなかった。`backend/genzoroom_tag_repair.py`では代表Assetに続けてStackメンバーを走査し、各Asset自身のタグ状態とfilenameで判定したうえでAsset ID単位に重複排除するよう修正した。JPEG EXIF検証、タグ付与処理、安全上限、ログ契約、Export Runtimeは変更していない。

Codexによる検証は、対象テスト**81件成功**、Backend全テスト**866件成功**、`compileall`成功、`git diff --check`成功。

NAS / Immich実機ではHomeを再取得し、自動タグ修復が動作してGenzo01へ`GenzoRoom`タグが復旧した。Backend Structured Logで`tagRepair.completed`を2件確認し、2件とも`result=restored`、`PUT /tags/assets`はHTTP 200だった。処理時間は1,984msと1,307msで、両方とも同一のGenzoRoom tag IDを使用した。2件目の修復対象Assetがどの写真かは特定・推測していない。この実機確認で確認できたのは自動修復の成功であり、初回Export登録時のタグ欠落原因が解明されたことを意味しない。

## Home Stack / filename / GenzoRoom tag改善とfocused audit（2026-10-08）

HomeのStackカードへ、full Stack snapshotから得たunique format badgeを追加した。Cover/primaryのformatを先頭にし、JPEG / DNG / HEIC等と既存member countを表示する。素材の選択・filterではない。optional metadataが欠損・不正でもAsset本体を落とさず、Frontendでもformat metadataをsanitizationする。実機で表示を確認済み。

長いfilenameは共通`FilenameDisplay`をPhotoCardとExportManagementで使い、prefix側を中央省略しながら拡張子と末尾の識別部分を優先表示する。完全なfilenameと処理上の値は維持する。実機で表示を確認済み。

Homeの「現」badgeはImmich `GenzoRoom` tagを根拠に表示する。Home asset取得時にtag状態をenrichmentし、`isGenzoRoomExport`をAPI responseへ含める。tag lookupは一括処理でN+1にせず、Stack childrenのtagは集約しない。badgeはcustom SVGで、配色をneutral grayへ調整した。実機で表示を確認済み。

Recent / Favorites / Album detail / Calendar day detailでは、Home response後にsilent background maintenanceとしてtag repairを実行し、Home表示を待たせない。tag absent、厳密なGenzoRoom export filename、JPEG EXIF Softwareのexact `GenzoRoom`がすべて成立するcandidateだけを対象とする。unknownはrepairせず、originalもcandidateだけ逐次取得する。pendingは128、originalは64 MiB、valid `NO_MATCH` negative cacheは512件までで、同一Assetのin-flight処理をdedupeする。Exportとrepairは共通tag assignment helperでupsert、asset assignment、応答検証、count=0時のAsset detail確認を行う。repairはbest-effortで、失敗してもHome閲覧を止めない。`tagRepair.completed`をinfo記録し、NAS / Immich実機でsilentなtag復旧成功を確認した。現行Exportでtag欠落Assetが見つかったが、原因は確定していない。Immich metadata extractionとのraceは到達可能な競合として監査で確認したもので、今回の欠落原因とは断定しない。

focused structural auditはHigh 0、Medium 1、Low 3だった。Mediumはmalformed EXIFがsoft-failしてNO_MATCHとなりnegative cacheされ得る点、LowはEXIFだけ読める構造破損JPEGがMATCHし得る点、極端に長い拡張子で中央省略表示を保証できない点、非常に小さいStack cardでformat群とcountが収まらない可能性だった。前二件を修正し、filenameの極端な拡張子は追加対応せず、Stack表示は実機で縮小してもJPEG + DNG + count等が読めることを確認して追加修正しなかった。

修正後のmarker判定は`MATCH` / `NO_MATCH` / `INVALID`の三状態。malformed EXIFやinvalid JPEGはwriteにもnegative cacheにも進まず、後続Home閲覧で再試行できる。marker/segment境界、必須table、SOF / SOS / EOI、EXIF TIFF header / IFD境界、Software field typeを検証し、pixel decodeは追加していない。XMP-onlyはrepair対象にしない。破損EXIF後に正常originalを再取得してrepairする回帰と、構造破損JPEGへtagを書かない回帰を追加した。

監査時の検証は関連Backend 341 passed + 121 subtests、関連Frontend 154 passed、Backend full 791 passed + 322 subtests、Frontend full 2394 passed / 2 skipped、`git diff --check`成功。監査修正後はFocused 163 passed + 49 subtests、Backend full 807 passed + 322 subtests、`git diff --check`成功。修正後はFrontendを変更していないためFrontend suiteを再実行していない。browser実機確認はユーザー側のNAS / Firefoxで行う。

## Export Favorite継承追補（2026-10-07）

お気に入り写真のExportで生成JPEGがFavoriteを継承せず、COVER化後にFavorites上の見え方が変わる問題を修正した。Immich v3.2.4 `POST /assets` multipartの`isFavorite`へsource値を渡す。Backend内部の`AssetDetail`に`isFavorite`を保持するが、既存Backend detail APIの公開レスポンスには含めない。Favorite値の欠落／boolean以外は`unexpected_response`とし、upload後の`PUT /assets/{id}`やAsset Copy APIは追加していない。Favorite ON/OFF両方のmultipartをテストした。

Backend full suiteは**712 passed**、関連再実行は**154 passed、72 subtests passed**。`compileall`と`git diff --check`も成功した。full suite途中にWindows asyncioの一時的な`WinError 10055`が1件発生したが、単独再実行と最終full suiteは成功しており、変更起因の失敗とは扱わない。Commit／Push／NAS deployは未実施。

## Phase 5 Export横断監査（2026-10-07）

Queue/Run transaction、worker ownership、Stop/reclaim、frozen Recipe/timestampとJPEG byte再現性、Immich upload/tag/Stack convergence、failure/privacy/resource境界、Frontend polling/Retry/armed/selection/Undoを横断確認した。High 0、Medium 3を再現して修正、Low 1（現行仕様の文書差分）を修正。残存High/Mediumは0。

1. Retryでfailedがqueuedへ戻ると主操作が通常Export表示になり、Start応答喪失後はRetry優先が消えてunrelated armed queuedのbadge/操作が復活した。主操作もretryPriorityで判定し、Start結果不明を保持してfresh runtime pollのactiveへ関連付け、confirmed idleまで抑止する。
2. Retry成功後のcanonical Queue refresh失敗をhookが吸収し、自動Startへ進めた。Retry-to-Startとruntime同期はfailed/aborted/superseded refreshを拒否し、成功済みqueued intentはrollbackしない。
3. active poll失敗を挟んだ終了やterminal Queue refresh失敗後に同期が止まり、古いwaiting/errorが残った。同期pendingをruntime認識とは別に保持し、idle確認とcanonical Queue取得が成功するまでpollで再試行する。Queue取得失敗で確定済みStart/Stop応答を無効にしない。

6件の回帰を追加。Backend Python 3.14.5、Export関連247 passed、full pytest 709 passed、compileall成功。Frontend Export関連305 passed、full 113 files / 2366 passed / 2 skipped、typecheck/build/diff check成功。既存500 kB超chunk警告あり。sandboxのBackend fixtureエラー／Frontend Temp cache制限は同じ環境で権限付き再実行して確認した。architectureへ現行Retry優先と同期stateのowner/invariantを追記し、READMEのRetry説明とCHANGELOGの過去phase記述の位置付けを補った。

実機成功事項はユーザー報告を監査前提とした。この監査でNAS deploy／live Immich／browser確認／Commit／Pushは行っていない。single Backend process、分散番号予約なし、partial registration rollbackなし、外部Stack変更race、同一source/toolchain前提のbyte再現性は維持する。コード上のPhase 5 blocking itemは解消し、UI polishへ進める。

## Phase 5F Export UI実機確認で見つかった2点（2026-10-07）

Stop requested表示は後続waiting itemだけへ限定し、currentAssetのencoding/registering（およびcurrentがwaiting中の場合も）は通常状態表示を保つ。左のselection actionから個別Retryを外し、failedがあると右の主操作を「出力を再試行」へ切り替えた。failed IDsをQueue順で確認・freezeし、実行時に再検証したうえで全件Retry成功時だけ同じID群でnew runを開始する。部分Retry failureはrunを開始せずQueue refreshし、成功済みqueuedはrollbackしない。通常armed queued Export、Q removal、W/Q one-shot Undoは維持。live再確認は未実施。

その後、Retry対象外のarmed queued itemへ「出力待機中」が表示され、Retry処理中の操作対象にも混ざる表示・操作不整合を修正した。armed stateは保持したまま、failed／Retry確認・処理中／Retry run activeの間はbadgeを抑止し、selection・Select All・Q対象をfailedだけへ限定する。failedがなくなりRetry runが終了すると通常queued操作と保持済みbadgeが戻る。

Retry優先中はfailedだけ操作可能である理由を画面右上に説明表示し、Retry解消後は非表示にする。live再確認は未実施。

Export関連74 passed、Frontend full suite 113 files / 2357 passed / 2 skipped、`npx tsc --noEmit`、`npm run build`、`git diff --check`成功。既存Vite 500 kB超chunk警告あり。NAS／Firefox実機確認とCommit/Pushは行っていない。

## Phase 5F実機Export: Stack contextの対象限定修正（2026-10-07）

ユーザーの最初のNAS実機Exportではsource取得／family検索／encode／upload／GenzoRoom tag付与まで成功し、Stack mutation前の`stack_context`で失敗した。Registrarがライブラリ全体のinvalid/quarantined Stackをglobal fatalとしていたため、source/outputと無関係な異常までExportを拒否していた。

既存strict Stack parserは維持し、source/output自身がquarantinedの場合だけcontextを拒否するよう修正した。対象のinvalid/ambiguous ownershipをunstacked扱いせず、無関係なsingleton／missing-primary／malformed／ambiguous Stackは妨げない。既存A〜E registration、旧member保持、output COVER、STACK管理algorithmは変更していない。拒否logへ安全なtarget quarantine booleanと件数を追加した。upload/tag／family／timestamp／Queue／schema／Frontendは変更していない。対象限定の回帰テストを追加し、修正後のlive再確認は未実施。NASでは正常JPEG+RAW StackからのExportで旧member保持とgenerated COVERまで成功することを再確認する。

Python 3.14.5の指定venvで関連Export/Stack回帰306 passed、Backend full pytest 709 passed、compileall／`git diff --check`成功。sandbox内の関連pytestは進行停止して中断し、同じvenv・引数で権限付き再実行した。13ケースを追加し、対象scope・quarantine保持・別Stack conflict・旧member保持をfocused reviewした。残存High/Medium findingは0。Frontendは変更していないためtest/buildは未実施。Commit/Push/deploy/live確認は行っていない。

## Export Phase 5E Actual Immich Export Registration / Production Start（2026-10-07）

productionの`Immichへ出力`を接続した。armedな`queued`だけをQueue順に確認してStartし、保存済みRecipe/revisionをtransaction内で再検証・freezeする。`IMMICH_URL` / `IMMICH_API_KEY`から実Source／family provider／registrarをlifespanで構成し、active runはrequestから独立してstartup recoveryする。設定不足でもBackend全体は起動し、Startだけ503になる。Startは`POST /export/runtime/start`、1〜100 unique UUID、既存runtime projectionを返す。

family searchはImmich v3.2.4のstructured filterでIMAGE／非trash／family root prefix、stackedとTimeline外も含め、1000件cursor paginationを最後まで処理する。候補は既存`filename_family()`のfirst-dot／Genzo suffix／case-sensitive完全一致で再判定し、重複を除く。malformed/cyclic cursorや有限page上限に達した場合は不完全な一覧を使わず`family_context_failed`。filename/cursorはlogへ出さない。

JPEGを`POST /assets`へmultipart uploadし、sourceのImmich dateを`fileCreatedAt`、永続Export時刻を`fileModifiedAt`へ渡す。upload timeoutはconnect/pool 10秒、read/write 120秒で、redirectは追跡しない。201 created／200 duplicateとvalid UUIDだけを成功扱いし、source UUIDへの衝突は拒否する。`PUT /tags`でGenzoRoomをupsertし、generated Assetだけへ`PUT /tags/assets`で付与する。v3.2.4のcountは新規関連行の件数なので再付与は0になり得る。count 0はpermission filteringとも区別が必要なため、1回だけAsset detailでTag存在を確認する。

upload/tag後の最新Stack snapshotを既存strict parserで読む。A: source/outputがStack外ならPOST `[output,source]`。B: sourceが既存Stack内ならPOST `[output,current primary]`で全memberを取り込み、旧Stackの事前DELETEはしない。child sourceにも対応する。C: 同じStackならoutput primaryはno-op、別primaryはPUTのみ。D/E: outputが別Stackなら自動merge/moveせずfailure。POST/PUT応答のStack UUID、output primary、source/outputと全旧memberの完全一致を確認する。既存`stack_write.py`／STACK管理write algorithmは変更していない。Asset/Tag削除は行わない。

SQLite schemaはv4のまま。既存runの不変`created_at`をExport timestampに使うためmigrationは不要で、既存v4 runも利用できる。同一clock millisecondでもnew runに新しいtimestampを確定する。artifact再生成に同時刻を渡し、XMPのmillisecondsを保持、LittleCMS sRGB ICC headerのcreation dateを固定してprofile IDを未指定0へ正規化した。これにより同じsource／frozen Recipe／codec toolchainの同run recoveryはJPEG bytesが一致し、duplicate uploadで同じoutput UUIDを回収できる。TagとStackは再適用・最新snapshotにより収束し、全登録成功後だけQueueから削除する。JPEG DB保存／binary cache／細かいremote checkpoint／distributed transactionは追加していない。

Start/Stop confirmationは既存dialogを再利用し、Cancelをinitial focusにした。二重confirmを同期guardで防ぎ、Start直前に最新Queue/statusを再確認する。Start受理で対象armedを解除し、高速終了でも取り残さない。Stopは指定JA/EN文言を表示し、現在item終了後に残りを解放する5D semanticsを維持する。既存polling／Queue reconciliation／status bars／failed RetryとW/Q one-shot Undoは維持し、Start/Cancel/Retry/successはUndo対象にしない。tab離脱は未確認intentだけを閉じ、workerを止めない。

必要なAPI key scopeはasset.read/view/download/upload、tag.create/asset、stack.read/create/update。ユーザー側で許可済みのasset.updateやtag.read/update、stack.deleteは既存管理機能の権限として維持する。Immich内部のAssetUpdate access checkとAPI key asset.update scopeは別概念。Frontendへ返す登録failureは固定`registration_failed`とし、Developer Logsにupload/tag/stack_context/stack phaseを安全なID/countとともに記録する。raw body／exception text／filename／credentials／URL／Recipe／JPEG bytesは出さない。

Focused auditで修正した点は、実際にrecovery bytes不一致を生んだICC headerのwall-clock時刻、XMP秒切捨てと同時刻new run、Tag再付与count 0の検証、Start最初のcheckpoint永続化failureの503保持、高速terminal Startのarmed整合、tab離脱時のconfirmation guard解放。修正後の再確認で残存High / Medium findingは0。

指定Windows `.venv`の実Pythonは3.14.5。Backend full pytestは**696 passed**、Frontend full suiteは**113 files / 2349 passed / 2 skipped**。Backend compileall、`npx tsc --noEmit`、`npm run build`、`git diff --check`は成功。buildの既存500 kB超chunk警告は残る。dependency pin／Docker／Recipe/History形式は変更していない。

partial remote成功は削除rollbackしない。active run再起動とterminal failedのRetryは区別し、後者の新Startは最新Recipe／新時刻で別outputになり得る。family番号は分散予約せずrare duplicateを許容し、Stack read/write間のmanual concurrent changeは応答検証で検出しても自動rollbackできない。single Backend processを前提とし、sourceやPillow/LittleCMS等が変わればrecoveryのbyte一致は保証しない。**Phase 5F**では実API permissions、JPEG upload/duplicate、archive/stacked family、GenzoRoom tag再付与、child sourceと旧member保持／COVER、撮影時刻/Timeline/metadata、登録途中restart／Stopを実機確認する。NAS deploy／live Immich／browser実機確認／Commit／Pushは行っていない。Phase 5Eは完了し、5Fへ進める状態。

変更ファイル:

- Backend: `backend/immich_export.py`, `backend/export_runtime.py`, `backend/export_runtime_store.py`, `backend/immich.py`, `backend/jpeg_codec.py`, `backend/jpeg_metadata.py`, `backend/main.py`, `backend/tests/test_immich_export.py`, `backend/tests/test_export_artifact.py`, `backend/tests/test_export_runtime.py`。
- Frontend: `frontend/src/ExportManagement.tsx`, `frontend/src/useExportManagement.ts`, `frontend/src/useExportQueue.ts`, `frontend/src/useExportRuntime.ts`, `frontend/src/exportQueueApi.ts`, `frontend/src/locales/ja.json`, `frontend/src/locales/en.json`, `frontend/src/ExportStart.test.tsx`, `frontend/src/useExportManagement.test.tsx`, `frontend/src/useExportRuntime.test.tsx`, `frontend/src/exportQueueApi.test.ts`。
- Docs: `docs/architecture.md`, `docs/development-notes.ja.md`, `CHANGELOG.md`, `README.md`。以下のPhase 5D以前は当時の記録を維持する。

## Export Phase 5D Stop / Retry / Restart Recovery（2026-10-07）

SQLite schema v4へtransactional migrationし、runに永続`stop_requested`と`current_position`、terminal `stopped`、itemにterminal `released`を追加した。v3のedit-state/Queue/run/item全column・順序・frozen Recipeを維持し、既存encoding/registeringをcurrentとして移行する。Recipe/History保存形式は変更しない。v3専用Backendへ戻す場合はmigration前の整合したDB backupが必要で、復元により以後の書込みは失われる。自動downgradeは実装していない。

source取得前にcurrentをDBで確定する。Stopと次item開始を同じwriter transactionで排他し、currentは強制停止せず成功/失敗まで継続する。そのterminal transactionで未開始waitingだけをQueue `queued` / run item `released`へ戻す。currentなしなら直ちに解放し、重複Stopはterminal後もidempotent。releasedがあればrun `stopped`、なければ全成功`completed`／失敗あり`failed`とする。Stop自体はinfoで記録する。

Retryは1–100 unique IDsの全対象をfailedかつ現在のsaved Recipeがnon-default/valid/supportedと検証してからQueueだけをqueuedへ戻す。queued/active/missingは409、duplicates/入力/eligibilityは422、DB/corruptionは503。部分commitせず、過去failed記録・error・frozen Recipeを保持する。次runはその時点のsaved Recipe/revisionを新たにfreezeする。Retry自体はworkerを開始しない。

Recoveryはprocess-wide lockと既存start lock、DBのactive unique indexと旧worker UUIDのcompare-and-swapで直列化し、新worker UUIDをclaimする。current encoding/registeringとQueueをwaitingへ戻し、current/Stopを保持してsourceからJPEGを再生成しregistrarを最初から呼ぶ。未開始waitingは順次再開する。shutdown checkpoint／browser離脱とworker lifetimeの分離を維持する。単一Backend processの再起動を対象とし、分散worker leaseは導入していない。lifespanは`recover()`へ接続したが、production dependencies未設定ならclaim/変更せず保留する。fake successやhidden Startは追加していない。

APIは`GET /export/runtime`、`POST /export/runs/{runId}/stop`、`POST /export/queue/retry`を追加した。Recipe/worker token/raw exceptionを返さず、response shapeと固定codeを検証する。Frontendは2秒pollとactive/終了時のcanonical Queue refresh、light amber waiting／green activity／yellow Stop／red `出力失敗`、failedだけのsingle/bulk Retry、active認識時だけのCancelを追加した。混在Retryを拒否し、Retry/CancelはW/Q one-shot Undoへ入れない。failedカードのstatus表示を優先してもarmed stateは従来どおり保持し、activeではarmed/selectionを除外する。

Python 3.14.5の指定Windows `.venv`でBackend full pytestは**641 passed（Phase 5D新規52件）、317 subtests passed**。Frontend full Vitestは**112 files / 2340 passed / 2 skipped**、Phase 5D実装中の関連6 filesは130 passed。BackendとFrontendの並行full run時は既存AlbumテストでWindows socket buffer不足（WinError 10055）が発生したが、Backend単独再実行は全成功した。通常sandboxではpytest/Vitestの一時ファイル制約が出たため、同じ環境/コマンドを権限付きで実行した。compileall、`npx tsc --noEmit`、`npm run build`、`git diff --check`は成功。buildの500 kB超chunk警告は残る。NAS deploy／browser実機確認／Commit／Pushは行っていない。

Focused static auditはHigh 0 / Medium 3を修正し再確認した。active Stopでcurrentが欠落する矛盾とreleased suffixの検証を追加し、古いruntime pollがStop acknowledgementを上書きしないgeneration guard／Cancel中poll保留を追加、unmount後に旧pollがtimerを再作成しないeffect lifetime guardを追加した。Stop/開始・完了のrace、0件DML rollback、Retry全体rollback、stale ownership、registration実試行中断後のreplay、shutdown、logger故障、UI canonical refreshと既存W/Q Undoを回帰確認した。残存High/Mediumは0。

Production `Immichへ出力` Startはdisabledのまま。actual family lookup／Immich upload-registrationとidempotency・duplicate tolerance／GenzoRoom tag／Stack／COVERは**Phase 5E**、real NAS/Immich integration testは**Phase 5F**。5Eへ進める状態。

変更ファイル（23件）：

- Backend: `backend/edit_store.py`, `backend/export_runtime_store.py`, `backend/export_runtime.py`, `backend/main.py`, `backend/tests/test_export_runtime.py`, `backend/tests/test_export_recovery.py`。
- Frontend: `frontend/src/exportQueueApi.ts`, `frontend/src/useExportQueue.ts`, `frontend/src/useExportRuntime.ts`, `frontend/src/useExportManagement.ts`, `frontend/src/ExportManagement.tsx`, `frontend/src/style.css`, `frontend/src/locales/ja.json`, `frontend/src/locales/en.json`, `frontend/src/exportQueueApi.test.ts`, `frontend/src/useExportQueue.test.tsx`, `frontend/src/useExportRuntime.test.tsx`, `frontend/src/useExportManagement.test.tsx`, `frontend/src/ExportManagement.test.tsx`, `frontend/src/GalleryExportManagement.test.tsx`。
- Documentation: `docs/architecture.md`, `docs/development-notes.ja.md`, `CHANGELOG.md`。

## Export Phase 5C Backend Runtime基盤（2026-10-07）

SQLite schema v3へtransactional migrationし、`export_runs` / `export_run_items`にtarget順・frozen Recipe/revision/version・lifecycle・worker UUID・固定failure codeを分離した。Queueと既存edit-stateの全column/保存形式を保持し、HistoryやJPEG/source binaryはrunへ保存しない。DB v2だけを読む旧Backendへ戻す場合はmigration前の整合したSQLite backupから復旧する必要があり、その後の書込みは失われる。自動downgradeは追加していない。

run creationは1–100 ordered UUIDsの全対象を同一writer transactionで検証してから`waiting`へ移行し、そのcommit時点でRecipeと対象をfreezeする。DBのactive-run/active-asset unique index、worker UUIDと元Queue row ID/status/timestamp、serial順の検証をprocess内start lockと組み合わせた。後からdefault Recipeを保存してもactive Queue rowは消えず、queued/failedだけが従来どおりcleanupされる。通常DELETEのactive lockも維持する。current edit-stateが変更/削除されてもfrozen Recipeは保持する。

requestから独立したserial workerを実装し、source original streamを閉じ、threadpoolで実Decoder/Renderer/Phase 5B artifactを生成してregistration boundaryへ渡す。全runのartifactを保持せず、source bufferはregistration前にclearし、各item終了時にartifact参照を解放する。fake registrarの明示的成功だけでowned registeringのQueue rowを削除できる。個別処理failureは固定codeでfailedに残し、残りtargetは継続する。DB/ownership/worker中断はactive stateを保持して停止し、restart inspectionで識別できる。

既存APIには正しいfamily全件の限定取得helperがないため`FamilyFilenameProvider`を境界として設けた。production coordinatorはfamily/registrar未設定で、StartはDB更新前に拒否する。Start endpoint、production no-op registrar、Immich upload/tag/Stack/COVER操作は追加していない。Frontend変更はなく「Immichへ出力」はdisabledを維持する。Retry/Stop/restart自動replay/ownership takeoverは5D、実registrationと本番Start開放は5Eへ残す。現Rendererと同じRecipe v18がRuntime対象で、v17 saved-stateの読み取り互換性は維持する。

Python 3.14.5の指定Windows venvでBackend full pytestは589 passed（新規Runtime回帰43件を含む）。migration rollback/idempotence/future refusal、all-or-nothing start、Recipe/default-save/dequeue race、serial order/duplicate coordinator、fake registrar success/failure、request cancellation、restart識別、実HTTPX stream/client closure、buffer clear/weakref解放を検証した。compileallと`git diff --check`も成功した。Frontendは未変更のためFrontend tests/buildは追加実行せず、NAS deploy/browser実機確認も行っていない。focused static auditはHigh 0 / Medium 3で、外部boundary例外とDB障害の混同、recovery読取りのQueue/serial整合性検証不足、0件DMLを成功扱いするpartial commitリスクを最小修正し、対応回帰が成功した。残存High/Mediumは0。

## Backend production Python 3.14移行（2026-10-07）

Production Docker baseを`python:3.14-slim`へ更新し、Windows development `.venv`とPython major/minorを3.14で統一した。requirements pin（FastAPI 0.141.1、HTTPX 0.28.1、Uvicorn 0.52.4、Pillow 12.3.0、NumPy 2.5.3）は変更していない。Windows `.venv`はPython 3.14.5で5依存をimportでき、Backend full pytestは546 passed、Python compileallと`git diff --check`も成功した。Docker daemonへ接続できなかったためDocker image build / container smokeは未実施。PyPIでPillow / NumPyのCPython 3.14 manylinux wheelと、FastAPI / HTTPX / Uvicornのplatform-independent wheelsを確認した。venvにpipがなくDocker buildも未実施のため、依存installをこの環境で実行確認したわけではない。

## Export Phase 5B filename / JPEG metadata（2026-10-07）

`ExportArtifact(filename, jpeg)` と `create_export_artifact()` を追加した。source JPEG bytes、source filename、呼び出し側が取得したfamily filename一覧、normalized `RenderedImage` を受け、filename決定 → source Decoder validation → whitelist metadata再構築 → 既存JPEG Encoderの順で処理する。standalone境界ではJPEG自体やcritical ICCの安全性を呼び出し側へ仮定しないため、sourceを追加decodeし、そのRGB bufferをmetadata処理前に破棄する。Renderer / Recipe pixel math、compatibility fixture、Queue、Diagnostics UI、保存形式は変更していない。actual Export RuntimeとImmich upload/register、tag付与、Stack/COVER操作は未実装。Immich `GenzoRoom` tagはPhase 5Eで扱う。

filename familyはFrontend Phase 0と同じfirst-dot root、terminal `-Genzo[0-9]+` の1回除去、case-sensitive、extension必須・末尾dot/empty root不可。source自身を含む同familyの最大番号+1で `<base>-GenzoNN.jpg` を生成し、欠番は再利用しない。2桁を超えても桁を切らず、巨大番号はdecimal stringで安全に比較・加算する。family一覧は非破壊で、Immich検索を追加していない。output rootにはpath/control/reserved punctuationを許可しないが、既存のfilename length方針がないため小さい独自上限は設けていない。完全なfamily取得、並行生成の予約・collision防止、upload先のlength制約は将来のOrchestrator責務。

EXIF whitelistは撮影日時/offset/subseconds、Make/Model、LensMake/Model/Specification、標準exposure/capture fields、Artist/Copyright/ImageDescriptionと位置・高度・時刻・方向の標準GPS fields。GPS BYTEのAltitudeRefがPillowでbytesになることを初回テストで検出し、semantic integerへ正規化して保持した。個別malformed fieldはdropし、読めないoptional containerはpreserveを諦める。source JPEG validationとcritical ICC failureは従来どおりfailure。Software/CreatorTool=GenzoRoom、Orientation=1、rendered寸法、sRGB ColorSpaceと新規sRGB ICCを生成する。同一runのaware UTC時刻からEXIF DateTime/OffsetTimeとXMP ModifyDate/MetadataDateをwhole-secondで生成し、DateTimeOriginalは上書きしない。

XMPは標準DC title/description（caption）/rightsのlanguage alternatives、creator sequence、subject/keywords bag、XMP Rating/Labelをpreserveし、fresh UTF-8 XMLへescapeして再構築する。source packet/private namespaceのraw copyはしない。これらの標準XMPに格納されたIPTC equivalentは対応するが、Photoshop APP13/IPTC IIM、extended XMP、private namespace alias、他のIPTC Core/Extension・任意structured fieldは対応外。EXIF ASCII fieldの非ASCII文字はdropし、Unicode user textはXMPで対応する。serial、MakerNote、vendor/RAW tags、source Software/Orientation/dimensions/ColorSpace/ICC、thumbnail/preview、Motion Photo/MPF/appended MP4/Ultra HDR/gain map/Google Containerは除外する。EXIF thumbnailは生成しない。

上限はtext field 16,384 bytes、RDF array 128 items、XML depth 12 / 1,024 elements、source XMP 65,504 bytes。DTD/entity declarationはUTF-16も含めparse前の拡張段階で拒否する。再生成EXIF APP1は65,533 bytes、XMPはheaderを引いた65,504 bytesを上限とし、aggregate超過はsafe `metadata_too_large`、serialize failureは`metadata_encode_failed`。optional dropはwarn、artifact生成のterminal failureはerrorとしてcode/countだけを既存structured loggerへ渡し、metadata値・filename・例外本文は記録しない。logging failureはexport結果へ影響しない。

Focused auditではmetadata leakage、private/vendor field、Orientation/寸法、case-sensitive collision semantics、実際のcorrupt EXIFとmalformed XMP、APP1総量、UTC秒境界、raw copy禁止、Pillow image/buffer lifetimeを確認した。残存High / Medium findingは0。source thumbnail IFD1、IPTC IIM/extended XMP、unapproved namespace/MPF/appended dataの除去、XML DTD/depth/elements/text/array limits、GPS malformed rationalとsafe loggingの回帰を追加した。並行生成時の同番号予約は5Bの純粋filename関数では行わず、Phase 5C以降へ接続する。

Backendのfilename/metadata、jpeg codec、renderer regression、Export Engine診断、Export Queueの関連5 filesは84 passed / 122 subtests passed。指定venvを使用した。sandbox内では診断testに入る時点で進行停止したため今回のpytestを終了し、同じ指定Pythonを通常環境で再実行した。変更Pythonのcompileと`git diff --check`も成功した。既存Python formatter/linter workflowは見つからず、新規導入していない。Frontendは変更しておらず、Frontend testsやbrowser実機確認は実施していない。Commit/Push/NAS deployはしていない。Phase 5Cから利用可能なartifact境界は完成しているが、Immichへ出力できる状態を意味しない。

## Export Phase 5A JPEG基盤完了・focused audit（2026-10-07）

Phase 5AをBackend JPEG Decoder / Renderer / Encoder基盤と、その読み取り専用Developer Diagnosticsの完了として閉じる。Export QueueとHomeの出力管理は実装済みだが、Actual Export Runtime、Immich upload/registration、RAW現像は未実装。次はPhase 5Bのmetadata / filename処理で、Runtimeの接続はPhase 5C以降とする。以下のPhase 4以前の「encoder未実装」「次はRuntime」等は当時の記録として変更していない。

Engine境界は将来のExport Orchestrator → Renderer → `RenderedImage` → Encoder。現在のRendererはNumPyでRecipe v18の全16 adjustment、category / individual enable flag、3WAY共通weight、stage順、clampとJS byte roundingをFrontend `adjustmentPipeline`へ合わせた。input非破壊、default fast path、full-resolution sRGB RGB8、16,384 pixel chunkによるfloat temporaryの抑制を維持する。Frontend / Backendの独立したfrozen compatibility hash、enable flag、chunk境界の回帰で互換性を検証し、既存fixtureは変更していない。

Pillow / ImageCms DecoderはJPEG originalのembedded ICCをsRGBへ変換し、EXIF Orientation 1〜8を正規化する。ICCなしのRGB / grayscaleは対応し、malformed ICCやuntagged CMYKは色を推定せず安全にfailureとする。Pillowのdecompression-bomb warning / errorがfailureになることも回帰で確認した。Encoderはoriginal/full resolution、quality 95、4:4:4、sRGB ICCで、source EXIF / XMP等のmetadata preserve / regenerateは未実装。Pillowをpixel adjustment Rendererとして使っていない。Production DockerはPython 3.13、Pillow 12.3.0 / NumPy 2.5.3 pinで、対象コードのPython 3.13構文とdependencyのPython要件を静的確認した。

Hidden Export Engine診断はrelease buildにも残し、保存済みRecipe revisionによる通常比較、original decode RGB8のDecode Compare、同じrunのpre-encode RGB8とBrowser decode JPEGを比較するEncode Round-trip Compareを備える。最終目視比較はFrontend Recipe resultとBackend generated JPEGの両方をexplicit sRGB Canvasへ描画し、Backend JPEGもproduction `decodeEditSource()`を通す。直接`img`表示には戻していない。Export Engineだけviewport幅へ広げ、左右1fr / 1fr、幅基準・aspect ratio維持の表示と狭幅1カラムfallbackを維持する。

候補sourceはRecent / Export Queue。Recentの既存JPEG候補抽出を維持し、Queue側はlistとAsset detail取得だけを使う。Queue順で逐次detail解決し、非JPEG / RAW / 個別取得failureを飛ばしながらeligible候補を最大10件集め、10件で停止する。Queue statusやRuntimeは変更しない。候補/source切替のreset、AbortController owner、pagehide / unmount / BFCache / stale guard、Object URLのdecode後revoke、両Canvas backing storeの0×0解放を監査した。JSON / failure logはsafe technical metadataとbounded error codeへ限定し、Asset ID、filename、写真内容、URL、Recipe / History body、pixels、credentials、filesystem pathは診断reportへ含めない。

利用者から共有された実機診断では、複数JPEGのFrontend / Backend original decodeがRGB8 byte単位で100%一致した。quality 95 / 4:4:4のJPEG round-tripはMAEが1未満程度、assessmentはminimalで、meanLumaDelta / greenBiasもほぼneutralだった。`greenBias = deltaG - (deltaR + deltaB) / 2`は傾向指標でありDelta Eや品質合否ではない。診断でgreen系統biasを裏付ける結果は得られておらず、Tint補正やgreen compensation、閾値調整は追加していない。これらは観測された画像についての利用者報告で、全JPEGへの保証や今回の自動テスト結果とは区別する。

重いRecipeではBackendの正常処理中に通常nginx 10秒read timeoutで`backend_unavailable`となった。diagnostic base / decode / roundtripの3 exact locationだけconnect 3秒 / read 1時間へ分離し、通常API 10秒、Stack apply 90分、Backend→Immich network connect 3秒 / read 5秒を維持した。1時間はproxy waitの安全上限で通常処理時間ではない。Decode / Round-tripのmanual Cancelと既存Abort lifecycleを維持し、新しいFrontend固定timeoutは設けていない。Client Abortは既に動いている同期Backend workerの強制停止を保証しない。分離後に14秒級処理が完走したことが利用者から共有され、12MP級・重いRecipeのrender約12〜13秒が主要bottleneckと分かった。現時点ではCPU性能baselineとして記録し、Renderer高速化、GPU / process pool / cache追加は見送った。

Focused static auditのfindingはHigh 0 / Medium 2 / Low 0。1件目は`exportEngineApi.ts`のRound-trip parserでRGB buffer確保がcleanupのtry外にあり、allocation failureでreader cancel / lock解放を逃す点。確保を既存finallyの管理範囲へ移し、JPEG + RGB合計byte countのsafe integer検証も追加した。修正前に2件の回帰で再現し、修正後はallocation failure、fragmented boundary、oversized stream、Abort時のcancel / unlockを確認した。2件目は`jpeg_renderer.py`で、保存データvalidatorが許可する小数Temperature / Tint（3WAYを含む）・Vibrance / SaturationをBackendが丸めず処理し、Frontendのscalar normalizationとpixel結果が異なる点。Frontendと同じJS Math.round semanticsを準備処理へ加え、正負のhalf tieとhalf直前を含む回帰で既存frozen mixed hashへ一致することを確認した。整数sliderの結果、既存fixture、保存形式、Decoder / Encoder / ICC、JSON schema、統計・閾値、Queue / Runtimeは変更していない。

今回の検証はBackend関連7 filesで59 passed / 73 subtests passed、Frontend関連11 filesで202 tests passed。ローカルvenvはPython 3.14.5であり、DockerのPython 3.13で実行したという意味ではない。Backendのsandbox実行は診断routeで進捗停止したため当該プロセスだけを停止し、指定venvの通常環境で成功した。Frontendもsandboxの一時ファイルENOENTを避けて通常環境で成功した。`npm run typecheck` scriptは存在しないため`npx tsc --noEmit`を使い、型チェックと`npm run build`は成功した。Buildには既知の500 kB超chunk warningが残る。文書同期後の`git diff --check`も成功した。nginx実行ファイルと稼働Docker Engineがないため`nginx -t` / Docker buildは未実施で、NAS deploy・Firefox / Chrome実機確認も行っていない。

## Export実装 Phase 4 完了（2026-10-07）

このフェーズを **Export management UI / selection / readiness / Queue management** の完了として閉じる。Export Runtimeには進めていない。HomeのHeader / Tabs / Toolbar / Content shellを維持し、Gallery系4タブと間隔を空けたmanagement groupへExportを追加した。英語ラベルは`Export`、日本語は`出力管理`、shortcutはE。専用routeは作らず、`showExport`で表示を切り替え、Galleryのtab・filter・selection・Album/Calendar詳細・scrollを保持する。STACK管理のHome tab化と暗室navigation追加は別フェーズ。

Persistent Queueをmembership・順序・statusの正とし、`useExportManagement`がExport固有のselectionとfrontend-only `armedIds`を管理する。selectionは操作対象指定だけであり、armedとは分離した。将来Previewなどでselectionを外しても出力予定を失わないための境界で、Preview自体は未実装。armedは初期0、storage保存なし、同じHome mount内のtab往復とselection clearで維持する。DB status `waiting`とは別で、`queued` ↔ `failed`変化では保持し、Queue消失またはlocked statusへ変わるとselection・anchor・armedをreconcileする。

カードはQueue IDだけのAsset detailをconcurrency 4で取得し、既存Immich Stack refreshのvalidated membershipをjoinする。Queue外memberは表示しない。同じStackのQueue memberが2件以上なら、非連続でも最初のmember位置に1groupへまとめ、内部はQueue順を保持する。1件ならstandalone。DB順は変更せず、Shift rangeはgrouping後の画面順を使う。normal clickは単一選択、Primary clickはtoggle、Shiftはinclusive range add、anchorなしの初回Shiftはno-op。checkbox、Select All / Primary+A、Clear / Escも共通selection semanticsに揃えた。

Toolbar左はcount / Select All / Clear / W出力待機toggle / Q Queue除外のselection group、右は共有thumbnail sizeと赤系Immich action group。Gallery固有のSTACK / 暗室遷移をExportへコピーしていない。Wはselected mutable itemsにunarmedがあれば全件ON、全件armedならOFF。Qは開始時の対象IDをQueue順にsnapshotして既存dequeueを順次実行し、二重実行を防ぐ。途中failureでも残りを処理し、成功分をrollbackせず、最後にrefreshとlocalized partial failure alertを行う。成功itemは即表示から消え、Stack groupが2件→1件ならsurvivor metadata再取得中も即standaloneへ戻る。`queued` / `failed`だけがmutableで、`waiting` / `encoding` / `registering`はselection・W・Q不可。unmountとstale async、既存Queue snapshot / mutation race対策も維持した。

Armed表示は当初の中央小型badgeから、狭幅英語ラベルの縦折り返しを避ける全幅status barへ変更し、中央36px→30px→28px固定・thumbnail下端へ調整した。確定仕様はthumbnail内absolute overlay、`bottom: 0`、width 100%、左右marginなし、height 28px、中央揃えの1行、nowrap / overflow hidden、背景90% alpha、文字opacity維持。画像領域は縮めない。日英文言は`出力待機中` / `Ready to export`のまま。将来同じ位置・高さをruntime status / progress barへ拡張する予定だが、今回progressやruntime表示は実装していない。Home / Export / STACK管理のカード背面は共有`--bg-content: #111214`で、card/panelとHeader/Tabs/Toolbarの色は維持した。

完了前focused static auditは指定25項目を横断確認し、初回Critical 0 / High 0 / Medium 0 / Low 0。責務分離、reconciliation、W方向、Q部分成功と競合、stale/unmount、groupingとrange順、2→1 collapse、shortcut guards、locked accessibility、checkbox focus、status bar、narrow toolbar、日英locale、disabled実行button、Runtime境界について実害のあるfindingはなかった。finding修正とその再監査は対象なしとし、監査目的だけのコード変更は行っていない。

検証は関連Vitest 20 files / 411 tests passed、Frontend全test 104 files / 2207 passed / 2 skipped。`npx tsc --noEmit`、`npm run build`、文書更新前の`git diff --check`は成功した。buildには既知の500 kB超chunk warningが残る。Backend変更はなくBackend全testは追加実行していない。完了文書更新後の関連Vitestも20 files / 411 tests passed、diff-checkも成功した。

今回の利用者実機確認として共有された事実は以下。ブラウザー名は指定されていない。この完了作業ではNAS / ブラウザー操作や再確認を行っていない。

- Export card selectionが動作する。
- Selectionを外しても`出力待機中` armed表示が維持される。
- QによるQueue除外が正常動作する。
- Armed status barがthumbnail下端・28px高・全幅で表示される。
- Stack groupingが表示される。
- Queueから外したitemがExport表示から消える。

次フェーズは **Phase 5: Export Runtime**。`armed → waiting → Recipe freeze → encoding → registering → success/remove`の実行、JPEG encode、metadata処理、Immich upload、Stack/COVER更新とruntime progressは未実装。`Immichへ出力`はdisabledのままで、空dropdown/menuも表示しない。deployment手順変更はなく、`docs/deployment.md`は変更していない。

Export管理thumbnailは現在Immich由来のsource thumbnailであり、Queue内Assetを識別・管理するための表示とした。現行がJPEGのみのv0.1.0では暫定仕様とし、Recipe適用済みthumbnailは実装していない。RAWでは現像前後の見た目の差が大きくなるため、将来はRecipe適用済みpreviewが望ましい。RAW engineはLightCraftを候補調査中だが採用は未決定。engine選定後、RAW decode / demosaicを含むdeveloping pipelineでpreview-sizeとfull-size renderを生成し、同じdeveloping / Recipe interpretation / renderer pathを共有してresolutionだけ切り替える方向を検討する。preview cacheやdemosaic cacheも将来の検討項目で、いずれも未実装。

## Export管理 one-shot Undo追補（2026-10-07）

隣接するW（出力待機）とQ（Queue除外）の誤操作を戻せるよう、Export tab中だけ`Primary+Z`を既存Undo registry commandから`useExportManagement`のtransient one-shot recordへ接続した。Wは実際に変化したAssetごとに変更前armed値を記録し、Undo時にtoggleではなく前状態へ戻す。QはQueue順の逐次DELETEで成功したAssetだけを記録し、各Assetの削除前armed値を保持する。全件失敗・no-opは前のUndo recordを維持し、実際に状態を変えた次のW/Qはrecordを置換する。

Q Undoはrecordを一度だけ消費し、現在のQueue snapshotに存在するAssetを重複enqueueしない。存在しない対象は既存enqueue APIで順次再登録し、元が`failed`でもstatusは`queued`へ戻る。元のQueue順復元は保証しない。armed状態は再登録成功分だけ戻し、partial restoreでは残りを続行してfailure後にrefresh・localized alertを行う。Selectionは戻さず、Redoと永続履歴も設けない。Q / restore中はoperation guardでW/Q/Undoの重複を防止する。Queue消失・locked化したW record対象はreconcileで除外する。Home / STACK管理 / Anshitsuの既存Undoは変更しない。

関連回帰は8 files / 215 tests passed。Frontend全testは8 workerの並列実行で6件の非関連Developer Diagnostics / STACK管理ログtestが失敗したが、該当2 files単独実行は97 tests passed。並列度1の全suiteは104 files / 2221 passed / 2 skipped。`npx tsc --noEmit`とproduction buildは成功し、buildには既知の500 kB超chunk warningが残る。文書更新後の関連testは8 files / 215 tests passed、`git diff --check`も成功した。

## Export Queue persistence / API Phase 1完了（2026-10-06）

既存の`/data/genzoroom.db`へExport Queueを追加し、SQLite schema v2とv1→v2 migration、Asset単位Queue、`GET /export/queue`・`POST /export/queue`・`DELETE /export/queue/{asset_id}`を実装した。Queue順は内部連番で保持する。eligibilityはvalidated snapshotのcurrent Recipeで判定し、Historyだけが残るdefault Recipeは対象外。default Recipeの保存成功時はHistoryの有無に関係なく、edit-state保存と同じtransactionでQueueから自動削除する。

enqueueは複数Assetをatomicに処理し、already queued itemのstatus・順序・timestampを維持する。`queued` / `failed`だけをDELETE可能とし、実行中statusはlocked、存在しないIDはidempotent successとする。Frontend専用API moduleはresponseをstrict validationする。Queue timestampsはcanonical UTC millisecond `...Z`に限定し、それ以外のoffsetはcorrupt persistenceとして拒否する。

Export Phase 1 focused auditではCritical / High / Medium findingはなく、Low 1件（BackendがUTC以外のtimestamp offsetを許可）を確認して修正した。実装時のBackend関連テストは56 passed・52 subtests、Frontend APIは43 passedで、TypeScript check、build、`git diff --check`も成功。Eligibility修正後のBackend関連テストは61 passed・52 subtests、今回のtimestamp修正後は関連Backend suiteで63 passed・52 subtests。各修正時の`git diff --check`も成功。NAS / browser実機確認は未実施。Queue UI、Anshitsu / HomeのQueue操作、encoder、Immich uploadなどExport runtimeは後続Phase。

## Export Queue Frontend / Anshitsu Phase 2完了（2026-10-06）

Phase 2Aで`useExportQueue`とstrict validation済みFrontend APIを追加し、unknown / loaded membership、status、per-Asset mutation、Abort / unmount、failed load時の既存snapshot保持を実装した。Phase 2Bでは専用Queue badgeを増やさず、既存EditedBadgeをQueue state表示とtoggleへ拡張し、central shortcut registryにmodifierなしのQ/q commandを追加した。Phase 2CではAnshitsu / FilmstripへQueueを接続し、写真buttonとinteractive EditedBadgeをsiblingsにしてnested buttonを避けた。写真clickは従来どおりactive Assetを切り替え、badge clickはQueueだけを操作する。

Anshitsuのenqueueは必要なedit-state save、save成功とclean確認、current Recipeのeligibility確認、Backend enqueueの順に行う。Historyだけが残るdefault RecipeはEditedBadgeを表示するがenqueueしない。unvisited inactive Assetのedit-stateはQueue操作のためだけにGETせず、Backendをeligibilityの最終authorityとする。default Recipe保存時のBackend transactional cleanupに対してFrontendは必要なQueue refreshを行う。Q shortcutはactive Assetに同じtoggle処理を実行し、既存のdialog、menu、Settings、native input、IME、repeat、遷移／保存中guardを維持する。`queued` / `failed`は削除可能、`waiting` / `encoding` / `registering`はlocked。

Filmstrip badgeはQueue外を濃色背景＋白アイコン、`queued`を明色背景＋濃色アイコンで表示し、`waiting`はamber、処理中はgreen、`failed`はredとする。active枠との干渉を避けるFilmstrip専用位置は`bottom: 10px`。Home側の位置は変更していない。Queue load、追加／削除失敗、eligibility拒否は日英のlocalized alertで通知し、失敗時にQueue membershipを楽観更新しない。

Focused audit初回はCritical 0 / High 0 / Medium 2 / Low 0。Mediumは、default Recipe cleanup refreshが別Asset mutationで破棄される問題と、新しいGET snapshot後に遅延enqueue responseが古いmembershipを復活させる問題だった。`useExportQueue`のsnapshot generationとmutation / refresh開始順を管理し、競合GETのrefreshを最後のmutation後に一度再実行、古いenqueue full responseを対象Assetだけのmergeへ切り替える修正を行った。focused re-checkでは両finding解消、新規Critical / High / Medium regressionなし。追加2回帰テストはいずれも最終Queue membershipを確認する。

実機確認ではNAS / FirefoxでQueue外とqueuedの配色、active枠、Filmstrip badge操作と写真選択分離、Q、dirty save後enqueue、default Recipeのenqueue拒否、Tab focusを確認し、Portainer Docker buildも成功した。`waiting` / `encoding` / `registering`はExport runtime未実装のため実機対象外。CSS static testがNode APIを参照した一時的なDocker build失敗は`style.css?raw`へ切り替えて解消した。

Phase 2C実装時の関連Vitestは12 files / 405 tests passed。EditedBadge表示色修正後は15 tests passed。focused auditは11 files / 283 tests passed。Medium修正後とre-checkはそれぞれuseExportQueue / Anshitsu Queue 2 files / 35 tests passed。各段階で`npx tsc --noEmit`、`npm run build`、`git diff --check`は成功。buildの500 kB超chunk warningは継続。実機確認は上記のユーザー確認記録であり、この開発ノート更新時に再確認していない。Home Queue controls、Export page、runtime、encoder、Immich uploadは未実装。

## Export Queue Home連携 Phase 3完了（2026-10-06）

Phase 3AでHomeのEdited判定をcurrent Recipeがnon-defaultの場合だけtrueに整理した。`has_edits()`のHistory-inclusive semanticsは維持し、Backend bulk edit-statusは`has_non_default_recipe()`相当を使用する。Stack代表は全`stackMemberIds`のstatusを集約し、1枚でもnon-defaultならedited、全memberがknownかつdefaultならunedited、unknownがあれば既存のunknown扱いを維持する。Anshitsu Filmstripにはdefault Recipe + retained HistoryをHistory-onlyとして表示し、既存3本スライダーSVG、localized label、noninteractive表示を再利用した。Homeには表示せず、Queue対象にもしていない。NAS / FirefoxではHomeからHistory-onlyのEdited表示が消え、current Recipe基準になることを確認した。実機確認後、History-only iconはopacity 0.6へ調整した。

Phase 3Bで`useExportQueue`をHomeへ接続し、PhotoCardの写真buttonとinteractive Queue badgeをsiblingsにした。standalone badgeはQueue状態に応じてenqueue / dequeueし、Stack代表は1 member以上がQueue中ならONとなる。StackをONにするとcurrent Recipeがnon-defaultのmemberだけを追加し、OFFにするとQueue中のmemberを全解除する。partial Stack専用表示は設けない。member IDを重複除去し、最大100件の順次enqueueへ分割する。途中failureは成功分を維持し、残りを止めてQueue refreshとlocalized error表示を行う。NAS / FirefoxではJPEG同士のStackでAnshitsuから片方をQueueへ追加し、Home代表badgeのON/OFFとStack解除後の両Asset Queue-outを確認した。standalone / Stack badge操作とselection維持も確認した。

Phase 3CでRecent、Favorites、Album詳細、Calendar日付詳細の複数選択にQを追加した。eligible代表にOFFがあればON方向としてOFF代表だけを操作し、全代表がONならOFF方向としてQueue中memberを全解除する。unedited、History-only、unknownは方向判定から除外し、partial Stack ONはON方向で変更しない。enqueueは重複除去後100件単位で順次処理する。locked memberを含むbatch拒否、busy中の二重操作防止、途中failure後のrefreshとrollbackなし、selection維持を実装した。Home Q専用で全input由来イベントを拒否する。NAS / Firefoxで主要な複数選択Q動作を確認し、History-only表示もQueue対象外のまま許容できる明るさであることを確認した。

Phase 3 focused auditではCritical 0 / High 0 / Medium 2。Home Qがcheckbox / range等で発火する問題はHome Q専用input guardで修正した。Stack badge clickが101件以上を単一POSTしてAPI上限を超える問題は、badge clickとQ batchでmember抽出、canonical ID重複除去、100件chunk、順次enqueue、failure後refreshを共通化して修正した。修正後focused re-checkでは両finding解消、新規Critical / High / Medium regressionなし、Phase 2のcleanup refresh再試行とstale enqueue response防止を維持し、Phase 3をclose可能と判断した。

Phase 3Aの関連Vitestは17 files / 483 tests passed、Backendは64 tests passed。Phase 3Bは19 files / 503 tests passed。Phase 3Cは関連Vitest 56 tests passed。focused auditは12 files / 366 tests passed、Backendは36 tests passed。Medium修正後およびfocused re-checkは各12 files / 379 tests passed。各段階でtypecheck、build、`git diff --check`は成功し、buildには既知の500 kB超chunk warningがある。NAS / Firefox確認は上記のユーザー実機確認記録であり、この文書更新時には再確認していない。Export page、actual export execution、encoder、Immich uploadは未実装。

## Home刷新フェーズ完了（2026-10-05・現行仕様）

HomeをHeader / Tabs / Toolbar / Contentの4層へ整理した。Header、tab、toolbarは固定領域に置き、`.home-content`だけをscrollさせる。旧来のHome全体を囲う大きな写真panelをなくし、HomeとSTACK管理はneutral dark themeの基本tokenを共有する。通常UIはgray基調で、意味のあるstatus色は維持する。Developer Diagnosticsはgreen console identityを保ち、controlsのみneutral grayで視認性を高めた。Anshitsuのthemeはこの刷新では変更していない。

Home headerはGenzoRoom、Immich接続状態、Settingsで構成し、旧`写真現像室`と開発statusを除いた。4 tabはRecent / Albums / Calendar / Favorites。写真viewのSelection groupはToolbar左端にまとめ、Recent、Favorites、Album詳細、Calendar日付詳細だけで表示する。Album一覧とCalendar月／年では表示しない。Toolbar右側はview既存のfilter／display controlsを維持する。Calendar month/year navigationはToolbar中央に置く。Album／日付詳細はwide desktopで左右対称3列の中央見出し、中間幅で見出しを別行、760px以下で各領域を別行にする。利用者から共有された実機確認では約1441px幅で1段、約1438px幅で見出しが折り返すことが確認され、旧`90rem` breakpointを`76rem`（標準16px基準で約1216px）へ下げた。共有情報には、この2つの画面幅に対するFirefox／Chrome別の内訳は含まれていない。

Selection groupは選択数statusと4操作を一体のsegmented controlにする。写真viewごとに選択IDとrange anchorを独立して保持し、filter外のselectionも残す。Select Allは現在の`visibleAssets`を既存selectionへ追加して順序を保つ。選択0枚での通常写真clickはAnshitsuを開き、初回Shift+clickはその1枚を選択してrange anchorを作る。Selection中の通常clickはtoggle、Shift+clickはanchorからrangeを追加する。checkboxの個別／range選択も維持する。英語UIのcompact actionは`Clear`、`Stacks[S]`、`Anshitsu[D]`（shortcut表示OFF時は`Stacks`、`Anshitsu`）で、説明的なaria-label／titleを別に保つ。Settingsでshortcut表示をOFFにするとvisible suffixと説明表示だけを隠し、shortcutは有効なまま。

Home commandsは`R` Recent、`A` Albums、`C` Calendar、`F` Favorites、`S` STACK管理、`D` Anshitsu、写真viewの`Primary+A` Select All。PrimaryはWindows／LinuxでCtrl、macOSでCommand。`D`は選択中ならそのasset群を開き、未選択なら同じSPA session内の直前のAnshitsu workspaceを再開し、sessionがなければno-op。`S`は選択時のみ有効。Anshitsu／STACK管理からGalleryへ戻るcommand IDは`workspaceReturnHome`のままbindingを`H`から単独`G`へ変更した。

Home return stateはtab、Album／Calendar detail、Calendar表示mode、page／content scroll位置を保持する。scroll restoration中にAnshitsu／STACKへ退出する場合、current `viewKey`と一致するpending位置を優先し、loading DOM位置で元のscrollを上書きしない。HomeReturn shapeと旧`pageScrollTop`互換は維持する。

focused audit初回結果はHigh 0／Medium 2／Low 1。見つかった3件（中央見出し付きToolbarの中間幅clip、scroll restoration pending中のroute exit、Album locale testの旧shortcut suffix）を修正した。後続確認で中間幅breakpointを`90rem`から`76rem`へ調整した。実機確認の記録は利用者共有の画面幅観測に基づき、今回の文書更新時にFirefox／Chromeの操作や再確認は行っていない。

Home刷新完了時のFrontend full regressionはVitest 93 files・1935 tests success、2 skipped。Node標準testは既存文書に記載の`node --test`で7件成功し、Vitest discoveryから`frontend/scripts/**`を除外した。`npx tsc --noEmit`、Frontend production build、`git diff --check`も成功した。buildには500 kB超chunk warningが残る。記録されたaudit修正と回帰検証は別々の確認であり、過去フェーズのテスト件数は各時点の値として保持する。

## Calendar左右navigation完了記録（2026-10-05・現行仕様）

実装commit `2331d87` でCalendar date detailに前後の写真日buttonとArrowLeft／ArrowRight操作を追加した。`useAdjacentCalendarDates`はyear heatmapを使い、`hasAssets === true`の日だけを最古年からcurrent yearまで探索する。同一effect内のrequest共有とHome mounted session内の成功データcacheを用い、date／tab／routeの変更で旧探索をabortしてstale結果を無効化する。実際の日付遷移は既存`openCalendarDay()`を通り、selection、scroll、asset request、year／month、HomeReturnの既存責務を引き継ぐ。

実装commit `15617fd` で左右ArrowをCalendar全体の時間軸操作へ統一した。Month viewは前月／次月、Year viewは前年／次年（選択monthを維持）、date detailは前後の写真日へ移動し、月・年境界も扱う。Month／Yearは既存buttonと同じ期間計算・`changeCalendarPeriod()`を共有する。最古／最新境界やnative controlではキーをconsumeしない。Calendar外のHome tabでは矢印操作を行わず、Home tabのArrowLeft／ArrowRight／Home／End切替を削除して全tabを通常のTab stopにした。Home tab間はclickまたはR／A／C／Fで移動する。

設計判断として、Home tabの矢印移動は実際のUXで使いにくく、Calendarの時間軸に左右キーを割り当てる方が自然なため、tab切替をやめてCalendar内で一貫した前後操作とした。前後日command IDは`calendarNavigatePrevious`／`calendarNavigateNext`。shortcut説明表示には追加しない。

Calendar date-detailのfocused static auditはHigh 0／Medium 0／Low 1。唯一の指摘は、写真日がない方向のdisabled矢印が共通`cursor: wait`を表示する点で、Calendar detail矢印だけ`cursor: default`へ修正した。Month／Year統合後の関連監査でも追加の実害は確認されなかった。

date-detail実装の関連6 test filesは142 tests成功、Month／Year統合後の関連4 test filesは111 tests成功。各段階で`npx tsc --noEmit`、production build、`git diff --check`も成功した。buildには500 kB超chunk warningが残る。

実装・監査後、利用者がNAS上のFirefoxとChromeでMonth／Year／Date detailの左右移動、月／年跨ぎ、native controls、境界、parent view復帰、disabled cursor、Toolbarを確認し、問題なしと報告した。これは実機確認の完了記録であり、この文書更新時にブラウザ操作を再実施した記録ではない。

## Calendar local-day境界統一（2026-10-05・現行仕様）

月表示はImmich timelineの`fileCreatedAt + localOffsetHours`でlocal dayを決めていた一方、date detailはUTC 00:00境界の`takenAt`検索を使っていた。この違いにより、UTC+地域の0時台などの写真が月表示の日付と異なるdetailへ入る場合があった。

date detailも既存`_calendar_month_images()`のlocal-day判定を使い、選択日のcandidateだけを抽出する。asset IDは順序を保って重複除去し、100件単位でmetadataを取得した後、timeline bucket順へ戻す。対象がない日はmetadata検索を行わない。最後に`_with_asset_stacks()`を通し、valid Stackのprimary-only表示、quarantine、Stack metadataを維持する。timeline取得失敗時にUTC検索へfallbackしない。Frontend API契約と`get_calendar_min_year()`は変更していない。

Calendar／Stack関連テストは162 passed、45 subtests passed。Backend全体は445 passed、191 subtests passed。`git diff --check`も成功した。テストではpositive／fractional offset、月／年跨ぎ、対象日だけの絞り込み、timeline順の維持、重複除去、empty day、timeline failure、Stack境界を確認した。

利用者はNAS上の実環境で、月表示では15日に出る0時台の写真が以前は14日detailに入っていたところ、修正後は15日detailに表示されることを確認し、「直っている」と報告した。ブラウザー名は報告されていない。

古い写真ではCalendarの日付と表示時刻が一致しない例が残るが、実際の撮影時刻とも一致しておらず、古いカメラのExifやtimezone metadataが不明確な可能性がある。これはmetadataが不明確なlegacy assetとして扱い、今回推測による補正は行っていない。

## 2026-10-04〜10-05: Structured Logging、Home / Stack境界、D&Dの記録

この節は2026-10-04〜10-05のGit履歴と現行コード、および利用者から報告されたFirefox実機結果を照合した記録である。Gitで確認できる実装と実機報告を区別する。ここに記載のないブラウザー確認やtest実行結果は推定しない。

### Structured LoggingとLogs UI

Frontend / Backendに独立したstructured loggerとDEBUG限定のImmich通信・Stack write診断を追加し、Developer DiagnosticsへLogs tabを統合した。Logs tabはFrontend / Backend別level設定、ALL / Frontend / Backend切替、clear、Backend refresh、個別・統合JSON exportを備える。Frontend bufferは1,000件、Backendは5,000件で、満杯時は古いentryをdropし`droppedEntryCount`を報告する。Frontend loggerのlevel・entry・clearはBroadcastChannelで同一originのtab間同期する。Developer Diagnosticsのpagehideまたはroute teardownでは、Frontend levelをOFFにし、Backendにもkeepalive付きでOFF設定を送る。bufferの内容はこの終了処理ではclearしない。

BackendのImmich request start / response / failureとStack write operation / batchのstructured eventを記録する。level semanticsとprivacy boundaryは`AGENTS.md`およびarchitecture.mdに記載した。ログ項目・context制限を変えず、API key、raw request/response body、画像データ等を通常loggerで収集しない。

不明DNGや削除済みStack childの調査ではDNG専用AssetDetail probeとRecentの`withStacked`比較probeを一時追加した履歴があるが、関連commitは後続でRevertされ、専用Recent観測コードもcleanupされた。Home用の`withStacked:false`も試行後にRevertされている。いずれも現行機能ではないため、Current featureとして扱わない。

### Singleton Immich Stack

Homeで`stackAssetCount === 1`を有効値として保持し、PhotoCardに赤い`1`と異常状態のaccessible labelを表示する対応を加えた。Stack管理は1 memberのImmich sourceをsingleton異常として表示するが、正常Stackとして編集させない。Add、member move、D&D、COVER変更を抑止し、group Purgeだけを許可する。Purgeは既存write planのDELETEへつながり、特別なAPI経路は作らない。未変更singletonはoperationにも`unchanged`完了にも入らず、送信後も候補に残る。operation 0件時は成功文言でなく「変更はありません。」を表示する。

singletonが生じた根本原因は確定していない。大量連続Stack作成等を原因とする証拠はないため、そのような説明は採用していない。

### Home写真一覧とStack境界

Immichで日付単位の削除後にStack childのDNGだけがRecentに残り、Calendarからは消える現象の調査を経て、Home metadata searchへ`trashedAt: {eq: null}`を適用した。さらにHomeの`/stacks` joinを非fatal化し、正常なStack metadataだけを採用、malformed・duplicate・ambiguousなentryのmemberと可能なprimaryをquarantineする処理を追加した。Homeは有効Stackのprimaryだけを返し、Stack childを裸の通常写真として再表示しない。primaryがsnapshotから欠落して残存memberだけが返るケースもHomeでは候補memberとして隔離する。

Recentはprimary-only / quarantine後に表示数が不足する場合、cursorを検証しながら必要なpageだけを追加取得する。cover assetには全Stack member IDを保持し、edit-status lookupとedited / unedited filterはStack全体の状態を集約する。Albumsは従来どおりArchive assetを含み得る検索条件を維持し、Timeline visibility条件を追加しない。Favoritesもprimary-only backend resultを使うが、現行Galleryではstacked/unstacked filterとcollapseを適用しない。一覧取得結果がprimary-onlyである点とFrontend filter差は区別する。

Home用の非fatal解析とStack管理用strict resolve/write validationを分離した。Homeは閲覧継続のため曖昧なownershipをquarantineする一方、Stack管理は曖昧・不完全なsnapshotをeditable sourceとして受理しない。Backend writeの最終member数下限（2件）も維持する。

### STACK管理 UIと操作

toolbarはwrite planからcreate / update / delete件数を表示し、operationがある場合だけsummaryを出す。個別delete-pending行は表示せず、send result statusはSTACK候補見出し行に置く。送信確認dialogとtoolbarは同じplan countsを使う。singleton warningとPurgingだけを許す制約は上記のとおり。normal StackのAdd、D&D、COVER、Purge、Undo、partial / unknown outcomeとcorrelated write semanticsは既存経路を維持した。

### Chrome / Firefox D&D対応とfire-drag原因特定

Chromeでimg自身のnative image dragが内部dragより先に始まり、transferに`Files`が入りcustom MIMEがないため拒否される診断結果を受け、STACK管理内thumbnail imgを`draggable=false`にした。内部drag sourceは親photo buttonとし、custom MIME `application/x-genzoroom-stack-photo+json`を使う。active payloadはReact stateに加えてrefにも同期保持し、custom MIME typeは存在するがgetDataが空で、file transferでない内部dragの場合に限ってref fallbackを使う。

Firefoxでブラウザー標準ghostが薄く暗くなる問題に対してdrag previewを複数回調整した。現行コードは透明native helperを`setDragImage()`へ渡してnative ghostを抑え、写真imgだけの別DOM previewを表示する。previewはrendered thumbnail寸法、opacity 0.88で、grab offsetをdrag開始時に記録してpointer追従する。以前のphoto-only `setDragImage` 案やopacity調整だけの案は最終方式ではない。

Firefoxのinvalid drop後にGoogle等の新規tabが開くという報告を受け、window / document capture observerを追加した。調査中はactive internal dragのwindow capture `dragover` / `drop`へ一時的に`preventDefault()`する対策も試したが、新規tab問題は続いたためpost-drag観測を追加した。利用者のログではdragend直後にblur、その後visibilitychangeが観測され、GenzoRoom内click / auxclick / navigationではない可能性が高まった。

その後の利用者実機確認では、Firefoxトラブルシューティングモードで問題が再現せず、通常モードでも`fire-drag`だけを無効にすると再現しなかった。この切り分けから、原因はGenzoRoomやFirefox標準D&DではなくFirefox拡張機能`fire-drag`と特定された。window capture suppressionは不要と判断して削除し、その後も`fire-drag`無効状態でvalid / invalid D&Dが正常に動き、新規tabが開かないことを利用者が確認した。

原因特定後、incident専用の750ms post-drag observer、timer、pointer / mouse / lifecycle listenerとlocation比較をcleanupした。現行コードにはdragstartからdragendまでの`dragSessionId`相関、dragover / dropのglobal観測、drop結果、DataTransferとdragend情報を記録する一般的な`stack.dnd` diagnosticsだけを残している。window / document capture observerは観測専用で、`preventDefault()`や伝播制御を行わない。今回の実機確認は利用者報告であり、この文書更新時にブラウザー操作を行ったものではない。

Git履歴上、調査途中のDNG / Recent probe、`withStacked:false`、Firefox ghost途中案はRevertまたはcleanupされている。現行実装の記述には含めず、必要な設計判断だけを上記の経緯として記録した。2026-10-04の各suiteの正確な実行件数はこの履歴とコードだけでは一括して再構成できないため、この記録では成功件数を補っていない。

## STACK管理 完成記録（2026-10-03・現行仕様）

当時のRecent／Album／CalendarはImmich Stackのfilterとcollapseを利用し、Type filterに応じてStack単位または個別asset表示へ切り替えていた。これは2026-10-04のHome primary-only変更より前の履歴である。現行HomeはStack primaryだけを返し、childを個別表示する設計ではない。Homeの順序付きselectionは、Favoritesを含めconcrete assetのままSTACK管理へ渡す。

STACK管理ページでは、選択assetからlocal draft Stackを生成し、既存Immich Stackもfull memberで取り込む。自動NAME候補はfilenameの最初の`.`より前をfamily rootとし、末尾のGenzo出力suffix `-Genzo` + 10進数字を除去して比較する。case-sensitiveで、RAW／Non-RAW構成を問わず同familyの2 asset以上を候補にする。NAME候補はEXIF情報の欠落・不一致・detail取得失敗があっても維持する。NAME familyに入らない非Stack assetは、TIMEとCAMがgroup全体で一致し、取得可能なGPS位置が既存許容差内なら、formatに関係なく2 asset以上のEXIF fallback候補にする。GPS欠落は許容し、malformed GPS、必須TIME／CAMの欠落、detail取得失敗があるassetはfallback対象外。候補への追加時はgroup全体を検証し、連鎖的な許容差超過を防ぐ。Homeの選択順と候補の一意所属を維持する。Coverを自動選択し、NAME／TIME／CAM／GPS evidence、既存StackのIMMICH、ローカル変更のMANUAL indicatorを表示する。

draft編集はCover変更、unmatchedからのAdd、Purge、新規MANUAL Stack作成、desktop Drag & Drop（unmatched → Stack、Stack → Stack、Stack → unmatched、unmatched photo → unmatched photo）に対応する。unmatched photo同士のdropは2枚からmanual Stackをatomicに作り、member orderはHome/orderに従い、Coverは既存`chooseStackCover()`規則を使う。Stack memberをunmatched photoへ落とした場合は新規作成に解釈せず、既存Purgeを維持する。dropで作ったStackもPrimary+Zの1-step Undoで2枚を元位置へ戻せる。元Immich Stackのmember集合とCoverへ戻すとlineageを復元する。送信は最終draft状態からunchanged／create／update／deleteを分類し、unchangedではAPI writeを行わない。Cover-only変更はprimary更新。Immich v3.2.4ではmembership更新を直接行わず、旧Stackをreleaseしてreplacementをcreateする。

STACK管理のUndoは直前のlocal draft構成変更を一度だけ戻す。Primary+Zのみで、RedoとUndoボタンは提供しない。snapshotはgroups／unmatched／manualCounter相当のdraft構造に限り、sourceやImmich送信結果は戻さない。source initialize／navigation generation／send開始／write result／resetで破棄し、Undo後は現sourceに対してmodifiedとImmich lineageを再計算する。no-op操作は有効なsnapshotを保持する。draft永続化は未実装。

当初、unmatchedが0件のときのSTACK候補外sectionに`min-height: 200px`を設定していた。これは後続の上下分割UIでGrid行の縮小を妨げるため、2026-10-09のSTACK-UI-01修正で削除した。現在は空状態もGrid行の高さに収まり、既存のsection全体drop handlerを維持する。

利用者の実機確認報告では、1-step Undo、unmatched同士のdropによるMANUAL Stack作成、Stack memberからunmatchedへのPurgeを含むD&D全体の挙動が想定どおり動作した。ブラウザー名や環境など、この報告に含まれない条件は確認済みとして記載しない。

送信結果はpartial success、failed、blocked、unknownを区別する。結果不明時はblind retryを許可せず、再検出を要求する。release後のreplacement失敗は旧Stack IDを保持し、dependency failureはblockedとして扱う。送信中に別selectionへ移動した場合、旧requestをabortし、旧responseやunchanged local completionが新しいdraftへ混入しない。再検出は1,000件単位でrefreshし、chunkをまたいで返る同一full Stackを重複排除する。long filename由来のUI group IDは変えず、Backend送信時だけ200文字以内のoperation IDへ対応付ける。

最終横断監査でMediumの4件（STACK送信のnginx timeout、same-route stale send response、長いoperation ID、1,000件超refresh）を検出し、修正した。`/api/stacks/apply`だけ90分timeoutとし、通常の`/api/`は10秒のまま。focused re-auditでは今回の4件に残存findingなし。

関連Frontend Stack testは14ファイル・198件、Backend Stack testは3ファイル・202件が成功。TypeScript check、Frontend build、`git diff --check`も成功した。buildには500 kB超のchunk warningがある。

利用者の実機報告では、NAS上のFirefoxで主要なSTACK操作を確認済み。Chromeについて、STACK管理の実機確認済み範囲を示す記録はなく、ここでは確認済みとは扱わない。これらは利用者による実機確認であり、今回の文書更新作業でブラウザーやNASを操作したものではない。

## STACK管理 第2フェーズ完了（2026-10-03・当時の完了記録）

以下は第2フェーズ当時の実装記録であり、現在のSTACK管理仕様と未実装範囲は冒頭の「STACK管理 完成記録」を参照する。

Homeで選択したassetを対象に、first-dot filename family rootとGenzo出力suffix除去による自動STACK候補判定を追加した。候補はImmich Stack未所属で、同familyの2 asset以上なら形式を問わず、Immichへ変更を送らずlocal draft Stack groupとして表示する。NAME候補はEXIF evidenceに左右されない。残る非Stack assetはgroup全体でTIME／CAM一致を要求し、GPSは比較可能なmember同士だけ既存許容差で比較するEXIF fallbackを使う。2枚以上の候補groupを作成し、各assetは一つのgroupにだけ所属する。

Asset detailはNAME candidate memberと、残りの非Stack assetが2件以上ある場合のfallback候補assetに要求し、既存Immich Stack memberは対象外とする。最大4件のbounded concurrency、AbortController、世代管理、再検出時の旧request破棄を行う。一部取得失敗でもNAME candidateは維持する。GPS latitude／longitudeをAsset detail EXIFへoptional追加し、CoverはRecentAsset.dateを使って最新JPEG、最新Non-RAW、最新memberの順で自動選択する。Homeと共有するthumbnail size controlを利用し、狭い表示幅ではuser preferenceを変更せずeffective columnsを減らす。NAME／TIME／CAM／GPS indicatorはmatched／mismatch／unavailable／errorの4状態とし、色に加えてscreen reader向けの状態textを設けた。

### 監査指摘と修正

監査で見つかった次の3件を修正した。

1. candidate外assetにもdetail APIを要求していたため、NAME candidate memberだけに限定した。
2. 狭いviewportで保存列数をそのまま使いサムネイルが細くなっていたため、saved columnsとeffective columnsを分離した。
3. indicator状態が色とtitleに依存していたため、4状態へ整理し、screen-reader-accessibleな状態textを追加した。

### NAS実機確認

利用者によるNAS実機確認では、実データのRAW + JPEG 2枚組を自動候補化し、複数の組が独立したdraft Stack groupとして表示されること、JPEGがCOVERに選ばれること、NAME／TIME／CAM／GPS indicator、候補外assetの下段表示を確認した。thumbnail size変更後もgroup memberが外側gridで分断されず、group単位でreflowすることを確認した。実在する3枚組Stackは確認対象になかったため3枚組の実機確認は未実施。3枚以上のlayoutはコードとtestsで一般化している。

第2フェーズ時点では、Purge、Add、Add待ちStack、manual Stack作成、DnD、manual Cover変更、Immich送信、既存Immich Stack再編集を後続段階へ残していた。これらは後続フェーズで実装済み。

## Home閲覧機能のまとまり（2026-10-02時点）

HomeはRecent、Albums、Calendar、Favoritesの4タブを持つ。RecentはImmich TimelineのIMAGEを新しい順に表示し、件数を50〜500件・50件刻み（初期値100件）から選ぶ。Recent、Favorites、CalendarはArchiveを含まないTimelineのIMAGEを対象にする。AlbumsはImmichのAlbum検索を使い、Album一覧・詳細ではArchive除外を追加していない。

Calendarは年表示（12か月）、月表示、日付別写真一覧を持つ。日付の有無と最古年はTimeline IMAGEで判定し、Archiveのみ、またはVIDEOのみの日を写真ありにしない。月表示の代表サムネイルはTimeline順のRAW以外IMAGEから選び、年表示ではサムネイルを取得しない。日付詳細もTimeline IMAGEを表示する。年／月コントロールはCalendarのスクロール領域内でsticky表示する。

FavoritesはBackendの`GET /assets/favorites`から取得し、Immichの`isFavorite=true`、IMAGE、`visibility=timeline`を条件にする。ページングは既存`_search_all_assets()`を利用し、成功した一覧は同じHome表示中に再利用する。Recent、Favorites、Album詳細、Calendar日付詳細は共通PhotoCardグリッドを使い、RAW／Non-RAWと補正あり／なしのフィルター、サムネイルサイズ、編集済み・形式badge、複数選択、Shift範囲選択、暗室への送信を備える。二つのフィルターはANDで適用し、フィルターはタブごとにsessionStorageへ保存する。サムネイルサイズは既存ブラウザー設定を使う。

選択IDとShift anchorは写真ビューごとに独立し、タブ切替では保持する。GalleryPageはRecent、Favorites、Album詳細、Calendar日付詳細用の`usePhotoSelection()`をそれぞれ1つ所有する。Album詳細とCalendar日付詳細を開閉した際のselection resetは既存遷移処理で行う。

Homeのscroll位置はRecent、Favorites、Album一覧、Album IDごとの詳細、Calendar年・月・日付詳細を別viewとしてメモリ上に保持する。暗室へ移動するときはタブ、Album／日付、Calendar表示モード、年月、page／content scroll位置をnavigation stateに渡し、Homeは必要なデータとDOMが準備できてから復元する。Album詳細・Calendar日付詳細ではアクティブタブの再クリックで親表示へ戻り、別タブへ移動した場合は詳細状態を保つ。

Album一覧の期間は日本語UIで`YYYY/MM`（例：`2002/09〜2025/11`）、英語UIでは既存の日付locale表記を使う。

Home構造の監査では、写真ビュー判定がasset・selection・edit status・toolbar等に分散し、selectionModeがtrueのままタブを切り替えるとEscape handlerが古いclear処理を参照し得る点を確認した。最小整理としてGalleryPageに`photoView`を導入し、写真ビューのassets、load state、selection、edit status対象を一か所で対応づけた。選択ID・anchor・toggle・clear・取得後の選択整理は`usePhotoSelection()`へまとめ、GalleryPageが4 instanceを保持する。Escapeは現在の写真ビューのclear関数に追従し、Recent／Favorites両方向の回帰テストを追加した。

この整理では写真ビューの選択と現在ビューの決定だけを対象にした。data fetch、Home return、scroll restore、panel描画、tab registry、connection statusはGalleryPageに残した。これらは取得再利用、非同期完了後のscroll復元、Album／Calendar固有の階層と結びついており、Stack等の具体的な仕様が固まる前に一括抽象化すると所有者と例外条件が見えにくくなるためである。STACK管理の現行実装は冒頭にまとめた。Export QueueとRAW現像は未実装。

## Keyboard command architectureと現行ショートカット（2026-10-02）

`editShortcuts.ts`に`ShortcutId`、`shortcutBindings`、`matchesShortcut()`／`matchesShortcutKey()`を持つapplication command registryを整えた。binding判定はregistryへ集約し、actionの実行と状態はHome、Anshitsu、Viewer、Filmstrip、Scopeなど各機能のownerに残した。TabやEscape、slider Arrow、component内focus navigationなどのlocal/native操作まで一律にcommand化しない設計とした。`shortcutDisplay.ts`と`useShortcutDisplay.ts`を追加し、bindingからTooltip／Menu表示を生成して設定へ反映する。

既存互換性として、JIS配列で`key=']'`となるphysical Backslashの優先判定、NumLock状態によらないNumpadのphysical `code`判定、AltGraph等のmodifier guardを維持した。Filmstripのhover／focus中の単独Arrow移動は廃止し、`Ctrl+Shift+←/→`による前後移動へ変更した。この2026-10-02時点の記録では暗室のViewer集中表示は`F`だったが、現行bindingは`V`である。`Shift+Z`はFitと直前zoom/panの切替、`H`は既存の退出保存経路を通るHome復帰となる。Homeの`D`は選択中なら現在選択で暗室を開き、未選択なら直前の暗室へ復帰する。

Home未選択時の`D`復帰情報はSPA session内のmodule memoryだけに保持し、Storage APIへ書かない。選択写真の順序とactive photoを保ち、Homeから再入場するときの`homeReturn`はその時点のHome表示状態で更新する。Recipe、History、Viewer transform等は保持しない。

`showKeyboardShortcuts`はdefault ONのbrowser preferenceで、ON/OFF radio UIから変更する。Tooltip/Menuの説明表示だけを切り替え、shortcut実行は止めない。Primary／Alternate modifierを`shortcutModifiers.ts`へ共通化し、Windows/LinuxではCtrl／Alt、macOSではCommand／Optionとしてmatchingとformatterの両方で解決する。Undo/Redo、Copy/Paste、選択Copy/Paste、Filmstrip、Settings歯車のmodified clickは論理modifierを利用し、Ctrl+Metaのような反対側modifier同時押しは一致させない。AltGraph除外は維持し、物理modifierが必要なbindingだけ明示指定する。modifier表示を実bindingと揃え、Before長押しとFit／前回表示切替は各ボタン操作と完全同義でないためTooltipに意味を明記した。Primary-modifier clickはclick handler内で同期的にDeveloper tabを開く。将来の実装規則のcanonical sourceはAGENTS.mdとする。

modifier表示を揃えるため、macOSのShift表記を`Shift`から`⇧`へ変更した。ShiftのmatchingはOS共通の`shiftKey`のままで、Windows/Linuxの表示は`Shift`を維持する。formatter testでUndo/Redo、Filmstrip、Shift単独commandの両platform表記を確認する。

検証では関連shortcut/UIのVitest 5ファイル・97件、Frontend全体Vitest 74ファイル・1465件成功（2件skip）、TypeScript check、Frontend build、`git diff --check`が成功した。buildでは500 kBを超えるchunk warningが出たが、modifier変更とは無関係な既知のwarningとして扱った。実機ブラウザや物理キーボードでの確認は行っていない。

### focused code auditと修正

shortcut、表示設定、Home↔Anshitsu復帰、各window listenerをfocused auditした結果はHigh 0／Medium 1／Low 0だった。唯一のMediumは、写真切替の保存失敗alertdialog中にUndo／Redoが背面のRecipe／Historyを変更できる問題だった。Anshitsuのworkspace共通keyboard block状態を`useAssetEdits`へ渡し、`failedSwitch`と`exitFailure`を含むblock中はUndo／Redo listenerを停止するよう修正した。Stayでdialogを閉じると通常のUndo／Redoへ戻る。

回帰テストは切替保存失敗中のCtrl/Cmd+Z、Ctrl/Cmd+Shift+Z、Ctrl/Cmd+Y、Stay後のUndo／Redo復帰、退出保存失敗中のUndo遮断を確認した。修正後のfocused auditでは報告対象のHigh／Medium／Low問題は残らなかった。現行作業ツリーでの関連Vitestは2ファイル・130件成功、TypeScript／Frontend buildと`git diff --check`も成功した。実機ブラウザ確認は行っていない。

## Keyboard shortcut横断確認（2026-10-08）

`editShortcuts.ts`のregistry、platform modifier helper、matcher、formatter、設定連動のTooltip／Menu表示、Gallery/Home、Anshitsu、STACK、Export、Filmstrip、Scope、共通Thumbnail size controllerのkeydown処理を軽く横断確認した。commandの所有者は各機能に残し、ページ共通化目的のdispatcher追加は行っていない。`showKeyboardShortcuts`は説明表示だけを切り替え、shortcutの動作は維持する。Numpad `-` / `+`はregistryで`KeyboardEvent.code`の`NumpadSubtract` / `NumpadAdd`を使い、Gallery/Home、Export管理、STACK管理の共通controllerからbuttonと同じbounded callbackを呼ぶ。通常のMinus / Equalは対象外。

監査はHigh 0／Medium 0／Low 2。低優先度の2件は、Thumbnail size shortcutにrepeatとopen dialog/menuの抑止がなかったこと。既存の他page commandと同じguardを共通controllerへ追加し、repeat、dialog、menu中に背面操作しない回帰testを追加した。input、textarea、select、range、contenteditable、IME、`defaultPrevented`と修飾キーも確認した。Registry内の同一キーはHome／STACK／Anshitsu等の別page contextで分離され、同一context内に明確な衝突は見つからなかった。shortcut表示OFF時も動作を保ち、tooltipは通常文言だけになる。

focused shortcut testsは17ファイル・580件、Frontend全体は116ファイルで2418件成功・2件skip。TypeScript check、Frontend build、`git diff --check`が成功した。buildでは既知の500 kB超chunk warningが出た。Numpad操作の過去の利用者側実機確認をCodexが再確認したものではなく、今回Codex自身によるbrowser／NAS実機操作は行っていない。

## Developer Diagnostics完了（2026-10-02・現行仕様）

### Phase 1: DeveloperページとSynthetic WebGPU Smoke

`/developer`をlazy-loadedなSPA routeとして追加し、Settings歯車の通常クリックはSettingsを開いたまま、Ctrl/MetaクリックではDeveloper Diagnosticsを新規タブで開く。旧`dev-webgpu.html`、`webgpuSmokeMain.ts`、独立Vite entryを削除し、React UIへ統合した。UIは日本語・英語に対応する。Developer Diagnosticsは任意の開発・診断用であり、通常利用者向けの主要導線には置かない。

### Phase 2: Environment、capability、report

ページ読込時のEnvironment snapshot、WebGPU adapter/device capabilities・features・limits、Synthetic Smokeの実行結果とtimingを追加した。`schemaVersion: 1`のJSON exportを導入し、既存Recipe・画像データ・Storage・認証情報をreportへ含めないprojection方針を定めた。診断結果のtelemetry送信やサーバーuploadは行わない。

### Real JPEG Diagnostics

Recent最大50件から最新のnon-RAW JPEGを自動選択し、手動選択では最大10候補を表示する。filenameはDeveloper UIだけに表示し、StorageやJSONへ保存しない。productionのJPEG original fetch、`readJpegProfile()`、`decodeEditSource()`によるsRGB ImageData化、`renderAdjustments()`、`WebGpuAdjustmentRenderer`、`collectHistogram()`を再利用する。16個のnumeric adjustmentと`all_sliders_representative`の計17ケースを直列実行し、CPU/GPU renderとHistogramのtimingを記録する。GPU sourceは1回だけuploadし、GPU失敗時もCPU結果を保持する。Abort、遅延resourceの解放、Object URL revokeとGPU disposeをrun lifecycleに結び付けた。

実写処理の計測対象はJPEG original取得、ICC/profile、sRGB decode、source Histogram、GPU初期化・upload、各ケースのCPU/GPU処理とHistogramである。`gpuRenderMs`はshaderのみの時間ではなく、production rendererのreadbackとCPU側copyまでを含む。単発観測であり、再現可能なbenchmark保証値として扱わない。

### UI整理とJSON出力

Environment / Capabilitiesを常時表示し、Real JPEGとWebGPUをタブへ分けた。診断componentはmountしたまま`hidden`を切り替えるため、選択・候補・filename・結果をタブ間で保持する。タブ状態はページローカルである。JSONはFull、JPEG-only、WebGPU-onlyの3種類とし、各reportのscopeを分離しながらschemaVersion 1を維持する。実機確認でactive/inactiveタブの明暗が逆に見える問題を修正し、WebGPUの実行・export操作をJPEG側と揃えて上部へ移動した。

### Firefox / Edge実機確認

Firefox 157とEdge 154でWebGPU SmokeとReal JPEG Diagnosticsの成功を確認した。同一JPEG originalとDisplay P3 profileで計測でき、重いadjustment処理ではWebGPUの処理時間がCPUより大幅に短くなることを観測した。FirefoxとChromium系ではWebGPU timing特性に大きな差があった。これらは当該環境の実機観測であり、固定性能値やbrowser間のbenchmark保証ではない。Developer Diagnosticsによりbrowser/runtime差を実機で切り分けられるようになった。

### 最終focused static audit

Developer Diagnostics関連コードに限定した静的監査では、Critical 0／High 0／Medium 0／Low 0だった。二重run防止、Abort/dispose、遅れて返るdevice/rendererの解放、closed ownerからのlate publish抑止、StrictMode/BFCache、GPU失敗時のCPU結果保持、Object URL/GPU resource cleanup、タブ状態保持、3種類のJSON projection、schemaVersion 1、export snapshot、filename等のprivate情報の非混入を確認した。コード変更は行っていない。

CPU renderとHistogram例外経路を直接検証する専用testはない。静的確認では状態遷移・cleanupに矛盾はなく、memory allocation failure等の低頻度経路を対象とする今後の回帰test候補として記録する。今回の修正は不要と判断した。

既知事項として、full Vitestでは既存Node test 2ファイルの誤収集によりsuite failureとなるが、専用Node runnerは成功している。Frontend buildには500 kB超chunk warningが残る。いずれもDeveloper Diagnostics追加に起因する新規failureとは判断していない。

## Settingsダイアログ（2026-09-29・現在仕様）

Homeと暗室で共通のSettingsダイアログをAppレベルで管理する。Routeや暗室を再マウントせず、暗室の編集session、HistoryとUndo/Redo、Filmstrip、既存autosave timerを保持する。Generalには表示言語（Auto／日本語／English）、表示言語から独立した日付・時刻ロケール、カレンダー週初め（Auto／日曜／月曜）を配置した。Auto言語はブラウザの優先言語を対応リソースと地域サブタグ込みで照合し、該当がなければ英語にする。日付ロケールAutoはブラウザの地域設定を使用する。週初めAutoはIntl.LocaleのweekInfoを利用し、非対応環境では地域に基づく決定的なfallbackを使う。週初め設定の取得処理は実装済みだが、Homeカレンダーはない。

Image Processingでは既存WebGPU設定をSettingsへ移し、ON/OFF設定と実際のGPU描画状態を分けて表示する。利用不能・初期化失敗・実行失敗時は既存CPU Worker、さらにWorker失敗時はmain-thread経路へfallbackする。Homeで可用性を調べる場合はpipeline probeを直ちに解放し、画像処理rendererを保持しない。初期表示画像はAuto／原版優先／PV優先で、AutoはWebGPUが有効かつ利用可能な場合だけ原版を優先する。原版取得中はPVを表示し、取得完了後に条件を満たせば切り替える。暗室での手動PV／原版選択は、その写真の非同期取得完了やGPU状態変化より優先し、写真切替時は古い取得を中止・解放する。初期表示選択はRecipe、History、保存snapshotに含めない。

接続情報にはGenzoRoomの開発版表示、Backend状態、Immich接続状態と`server.about`由来の公開バージョン／ビルド情報を表示する。APIキーはBackend環境変数に留め、Frontendには返さない。取得失敗や権限不足は任意情報の表示に限定し、既存の写真閲覧・編集を妨げない。Homeのコンパクトな接続状態表示は維持する。

設定キーは既存の`genzoroom.language`を再利用し、新規項目は`genzoroom.dateLocale`、`genzoroom.weekStart`、`genzoroom.initialImage`、WebGPUは既存の`genzoroom.webgpu.enabled`を使う。保存不能でもページ内の設定変更を維持する。日付表示にはIntl.DateTimeFormatを使い、タイムゾーン情報を持たないEXIF撮影日時をブラウザのタイムゾーンで確定しない。Recipe v18、History、SQLite schema 1、`processingVersion`（`jpeg-preview-srgb8-v1`）は変更していない。

翻訳エディター、キーボードショートカットのカスタマイズは未実装。

ダイアログはフォーカストラップ、Escape、閉じるボタン、閉じた後のフォーカス復帰を備える。外側で押下と解放の両方が起きた場合だけバックドロップクリックで閉じるため、内部から外へドラッグしても閉じない。表示中は暗室のグローバルショートカットを抑止し、背面操作を伝播させない。

WebGPU行の追加修正では、ほかの設定と同じ2列配置にし、項目名を左、トグルと小さな状態表示を右列へ揃えた。狭幅でも列の重なりを防ぐ。

4193429までの最終差分監査では、報告すべき実害のある問題は見つかっていない。報告済みの自動テストはFrontend 1,238件成功・2件skip、Backend 73件成功、TypeScriptチェック、build、`git diff --check`成功。通常の`npm test`では既存Nodeテスト2ファイルもVitestに検出されるため、Frontend検証は`npx vitest run src`で行った。NAS／FirefoxではSettingsの開閉、枠外クリック、設定保持、WebGPU切替、原版への自動切替、Immichサーバー情報表示を確認済み。

## WebGPU Phase G1〜G3（2026-09-29・現在仕様）

G1でRecipe v18以前の8bit sRGB JPEGを処理する独立した露出レンダラーを追加し、FirefoxとEdgeで実GPU描画を確認した。G2では現行CPU Pipelineを基準に16補正をWGSLへ移植した。処理順と段階ごとのクリップ・8bit丸めを保ち、Temperature、Tint、Exposure／Contrastの256値RGB LUTはCPUで生成して転送する。残るトーン、3WAY Color Grading、Vibrance、SaturationはWGSLで処理し、アルファは保持する。Recipe v18、永続化形式、CPU Pipelineは変更していない。

G2の実機検証では、WGSLの識別子`smooth`と`target`が予約語と衝突してコンパイルに失敗した。`smooth_weight`と`target_luminance`へ改名して解消した。修正後はFirefox・Edgeの114ケースすべてでGPU実行に成功し、CPUとの差は両ブラウザとも最大2階調、アルファ不一致とGPU実行エラーはなかった。

G3で暗室のJPEGプレビュー／原版にGPU経路とON/OFF設定を追加した。設定はブラウザに保存する。GPU非対応・初期化失敗・実行失敗・デバイス喪失時は、デコード済み画素からCPU Workerへ切り替え、Workerも失敗した場合は既存のメインスレッド処理を使う。NASのFirefoxでは、原版へほぼ全補正を適用する操作、GPUからCPUへの切替、暗室退出・再入場後の設定保持、プレビュー／原版とフィルムストリップの切替を確認した。GPU操作は快適で、CPUへ切り替えると明確に遅く感じられた。詳細ベンチマーク、処理時間、倍率は測定していない。G3暗室統合のEdge実機確認は未報告。

ブラウザ実機でのG1〜G2確認構成はWindows上のFirefox・EdgeとRadeon RX 580。RX 580は最低要件ではない。自動検証ではFrontend全54テストファイルの1,218件が成功し、実GPU比較2件はNode環境のためスキップした。型チェック、production build、git diff --checkも成功した。

Firefoxで開発用のSecure Context例外を使った際、HTTPで配信したサムネイルURLがHTTPSへ自動変換され、サムネイルが表示されなくなった。開発環境では`security.mixed_content.upgrade_display_content=false`にして回避した。この設定はFirefox全体へ影響するため、一般利用者向けの推奨設定ではない。また、Secure Context例外はHTTP通信を暗号化しない。通常はHTTPSまたはlocalhostを使用する。

## JPEG原版対応・最終監査完了（2026-09-29・現在仕様）

HomeとFilmstripはImmichのサムネイルを使い、暗室では選択中のJPEGだけをバックグラウンド取得する。取得中もプレビュー編集を続けられ、取得した圧縮原版は同じ写真を選択している間の表示切り替えで再利用する。写真切替・Unmount・原版デコード失敗では取得を中止し、不要なObject URLや画素状態を解放する。JPEG単独AssetとPixelの`RAW-01.COVER.jpg`は同じ経路で、DNG現像やJPEG／RAWペア管理は対象外。

原版表示はプレビューと同じRecipe、History、Undo/Redo、各ON/OFF状態を共有する。表示モードは暗室ローカルの状態で、保存recipeやHistoryへ記録しない。補正前／補正後、Fit、1:1、Histogramにも対応する。上部スイッチはプレビュー／原版を左、補正前／補正後を右の順とし、左History・右Developの開閉ボタンは状態に応じた矢印アイコンと日英ツールチップを使う。`]`で表示元を切り替え、Backslash押下中は補正前を一時表示する。JIS配列で`]`が`key: "]"`, `code: "Backslash"`となる場合は`]`を優先し、原版取得中・失敗時はBackslash処理へ流さない。入力欄、IME、モーダル／メニューの既存ガードは維持する。

原版のICCはImmich Asset EXIF APIではなく取得JPEGの埋め込みAPP2から読み、プロファイル名を「原版情報／Original Info」に表示する。画像サイズも原版由来で、プレビュー表示中も同じ原版メタデータを表示する。埋め込み情報がない場合にsRGBとは推測しない。画像デコードでは埋め込みICCを考慮したブラウザー管理の変換を経て、既存の8bit sRGB Canvasから画素を取得する。広色域作業PipelineやRAW現像は追加していない。

利用者によるNAS／Firefox確認では、Pixel 7 ProのJPEG単独撮影とRAW同時撮影のCOVER.jpg、sRGB／Display P3原版の表示、原版の解像感、スライダー、補正前後、Histogram、Filmstrip、ツールバーとパネル操作を確認済み。色は目視確認であり、厳密な色差測定ではない。補正を重ねた原版の更新は体感で約2〜3秒弱で許容範囲だったため、この対応ではインターロックや追加最適化を導入していない。これは性能ベンチマークではない。

最終静的監査はCritical 0件、High 0件、Medium 1件、Low 0件。JPEG取得、ICC、Worker、Histogram、保存経路に追加指摘はなかった。MediumはJIS配列の`]`とBackslash判定競合で、`]`を先に処理する修正と回帰テストを追加した。修正時のImageViewer関連テスト31件、TypeScriptを含むproduction build、`git diff --check`が成功し、修正後のUS配列での切替は実機確認済み。静的監査・自動テストはICCの厳密な色差精度を保証しない。

## Histogram H1〜H3 完了（2026-09-29・現在仕様）

暗室ScopeにJPEGプレビュー用Histogramを追加した。collectHistogram()はDOM非依存のpure functionで、RGBAの8bit sRGBコード値からR・G・B・Y′を各256個のUint32Arrayへ集計する。Y′は非線形RGBへBT.709系係数を適用し、Math.roundでビン化する。補正前はdecode成功後に一度だけ集計し、補正後は既存Workerのrender出力時に同じ画素結果から集計する。WorkerはpixelBufferとHistogramを同じresult messageで返し、Worker起動・処理エラー時のmain thread fallbackも同じ集計関数を使う。

requestId・assetGenerationが一致しないWorker結果と、pendingLatestがある間の古い結果は採用しない。写真との対応はassetId・sourceKeyで確認し、未取得のbefore／afterはnullのまま扱う。Viewerの実表示状態（永続BeforeまたはBackslash押下中）に合わせて該当するHistogramだけをScopeへ渡す。比較表示、Scope設定変更では再集計しない。

ScopeはRGBチャンネル、Y Only、通常／拡大を非永続状態として管理し、写真を切り替えても維持する。通常表示はRGB全チャンネル共通の最大ビン基準。拡大表示はRGBの768ビン、またはY Onlyの256ビンからゼロを含むnearest-rank P99を求め、上限を超えるピークをグラフ上端でクリップする。RGB選択は最低1チャンネルを維持する。

H2でScopePanelとHistogram SVGを追加し、Scopeの利用可能な高さに追従するレイアウトへ調整した。H3でViewerのBefore／Afterと一時Before表示を連動させ、Numpad 0〜3とNumpad Decimalを追加した。Y Only中のNumpad 1〜3は最初の1回でRGB表示へ戻り、次の押下からチャンネルを切り替える。テキスト・数値入力、IME、修飾キー、メニュー／ダイアログ、操作ブロック中は入力側を優先する。NumLock OFFではNumpad 2のevent.keyがArrowDownになるため、AdjustmentSliderのグローバル矢印処理からHistogram専用の5つのevent.codeを除外した。

利用者によるNAS／Firefox実機確認は完了している。最終静的監査はHigh 0件、Medium 1件、Low 0件。MediumのNumpad／AdjustmentSlider競合を上記のコード除外で修正した。修正後に報告された検証は、関連テスト88件、Frontend全43ファイル999件、TypeScript型チェック、本番ビルドが成功し、git diff --checkも空白エラーなし（改行コード変換警告のみ）。性能測定は実施していない。

## 暗室コンポーネント構造整理（2026-09-29・現在構成）

暗室ページの構成からFilmstrip、WorkspaceLayout、EditHistoryを独立させた。Filmstripは写真一覧、矢印キー移動、ホバー判定、表示位置とフォーカスを管理する。WorkspaceLayoutは左右パネル幅、ResizeObserver、リサイズ、幅の保存を管理する。EditHistoryはHistoryとcursorを受け取って行を表示し、選択やコンテキストメニュー要求を親へ通知する。写真切替、保存、History操作、Viewer／Histogramの接続はAnshitsuPageが統括する。

AdjustmentSliderにあった共有スライダーMap、現在の操作対象、キーボード／マウスの操作権、フォーカス移動・復元処理を`adjustmentFocus.ts`へ移した。AdjustmentSliderは各コントロールの数値入力、pointer、wheel、編集確定を保持する。`adjustmentNavigation.ts`はDOM上の移動先とスクロール、`editShortcuts.ts`はキー判定とネイティブ入力保護を引き続き担当する。AnshitsuPage、ColorGradingAdjustmentControls、ImageViewerは共有状態を新モジュールから参照する。キー操作の優先順位、移動前の編集確定、NumLock OFF時のNumpad共存を維持し、NAS／Firefox実機確認も完了した。

構造調査では、AnshitsuPageの独立した表示責務とAdjustmentSliderの共有フォーカス状態だけを分離した。`useAssetEdits`の読み込み、編集セッション、autosave／retry、退出時の保存とHistory圧縮は同じセッション状態と実行順序を共有するため、分割せず既存の責務を維持した。構造調査で緊急の設計上の問題は確認されず、必要性を確認できた分離だけを実施した。

各工程で報告された検証は、関連テスト238件、163件、323件が成功し、Frontend `src` 全体43ファイル・999件、TypeScript型チェック、本番ビルド、git diff --checkも成功した。実機確認は利用者により完了している。

その後、デスクトップのWorkspaceLayoutを上下2段にし、右パネルと右リサイズハンドルを画面最下部まで伸ばした。Filmstripは左パネルとViewerの下段へ移し、右パネルを閉じた場合は全幅を使う。モバイルでは既存の縦積みとsticky Filmstripを維持した。Scope種類の選択を見出し右側へ移して説明文を外し、ScopeとDevelopの間に高さ調整ハンドルを追加した。ドラッグと上下矢印で15〜40%を調整でき、初期値30%。`scopeSizing.ts`の専用localStorageキーで保存し、暗室再入場・写真切替後も復元する。不正値は初期値に戻し、40%を超える保存値は40%として扱う。左右パネル幅の保存とは独立している。

高さ調整の変更後はFrontend `src` 全45ファイル・1004件、TypeScript型チェック、本番ビルド、git diff --checkが成功した。初期値を30%へ変更した後はScope関連5件、TypeScript型チェック、git diff --checkが成功した。高さ調整についてブラウザ手動確認や性能測定は行っていない。

## 永続化 Phase 5（現在仕様）

JPEG写真を暗室でactiveにすると通常はedit-state APIから保存状態を取得し、成功後にrecipe、History、Undo/Redo cursorを復元して編集を許可する。退出保存失敗後に暗室に留まり、assetにdirtyなlocal stateまたは未確認saveが残っている場合は、再activation時にそのstateを保持してGETで上書きしない。明示的にdiscardしたassetは記録を破棄し、再訪時にDBから取得する。GET失敗時は空の編集状態として扱わず、再試行するまで編集できない。recipe / History snapshotが変化した編集操作の最後から5秒間変更がなければ、pendingをコピー側でcommitした非圧縮snapshotをrevisionとsaveId付きでautosaveする。autosave失敗は編集を保持したまま非ブロッキング警告を表示し、直後の自動retryを行わない。失敗後に最新snapshotまで保存できたら警告を解除する。通信結果が不明な保存（HTTP 408／5xx、成功応答の解析・検証失敗等）はDBで成功済みの可能性があるため、元のsnapshot・expectedRevision・saveIdを変更せず先に再送する。確認後に追加編集を保存する。別タブ等による真正なrevision conflict（409）は自動mergeしない。Filmstrip遷移時はautosave timerを停止し、dirtyな写真を最新の非圧縮snapshotで保存する。遷移保存失敗時はその写真に留まるか、未確認のローカル編集を破棄して移動するかを選べる。discard後も保存済み状態が確定済みなら編集済み表示を維持し、不明なら古い一括取得結果を使わずunknownとして扱う。Home controlで暗室を退出すると、そのAnshitsu session中に永続化対象の編集を行った全assetを順次処理する。最新snapshotをcopy上で作り、`COMPACT_HISTORY_ON_EXIT`が有効ならapplied / redoを分離したpure compactionとvalidation後に保存する。圧縮失敗時は非圧縮snapshotへfallbackする。成功済みassetはlive sessionも保存済みHistoryへ同期し、後続assetの失敗で詳細Historyが再autosaveされないようにする。最終保存失敗時は暗室に留まるか、rollback / DELETEなしで退出するかを選ぶ。Browser Back、reload、tab close時の同期保存・interceptは未実装。

## Copy / Paste（現行仕様）

Recipe v18の16数値項目を、`frontend/src/editClipboard.ts`の同一タブ内メモリ上のクリップボードで共有する。通常コピーは16項目、選択コピーは選んだ項目、単一スライダーコピーは対象の1項目を保存し、いずれも以前のコピーを置き換える。値は`effectiveAdjustments()`ではなくrecipeからコピー時点で複製し、source asset IDとfilenameも保持する。ON/OFFはコピーせず、個別項目がOFFでも保持されている数値を対象とする。Homeへ戻るなどのroute変更後も同じタブ内では保持するが、reload・タブ終了後は残さない。OS clipboard APIは使わない。

プレビューがViewerの操作対象で`Ctrl+C`を押すと全項目をコピーし、AdjustmentSliderの操作対象があればその1項目をコピーする。操作対象は`keyboardAdjustment()`で共有し、マウスホバーとキーボードフォーカス、Shift＋上下キーで移した既存の対象に従う。対象を別途記憶するCopy専用状態はない。`Ctrl+V`はスライダー／Viewerのfocusを要求せず、編集可能な現在の写真にクリップボード内容を適用する。写真切替中、編集状態の読み込み前、退出保存中、選択dialog表示中などは実行できない。数値・テキスト入力中はブラウザ標準操作を優先する。

`Ctrl+Alt+C`／`Ctrl+Alt+V`はViewerがキーボード操作対象のとき、共通の選択dialogを開く。White Balance、Basic、Color、Color Gradingのカテゴリに分け、Color GradingはShadows／Midtones／Highlights単位で区分する。Copyは全16項目を初期選択し、Pasteはクリップボード内の候補を全て初期選択する。ゼロ値も通常の候補である。カテゴリ一括選択、部分選択表示、全選択／全解除、確定・キャンセルを備え、0件では確定できない。確定ボタンを初期focusとし、候補がない場合は全選択ボタンへfocusする。Escapeでキャンセルし、checkbox上のEnterで確定する（0件またはIME変換中、Enter repeat中は確定しない）。Spaceでチェックを切り替える。ボタン上のEnterはそのボタンの標準操作を使い、Tab／Shift+Tabはdialog内を循環し、閉じた後は接続中の元focusへ戻る。AltGraphとIME等を誤認しない。Viewerの「⋯」menuにも全コピー、選択コピー、通常ペースト、選択ペーストを用意する。

Pasteは値を選んだ1回の`paste` actionで適用し、コピー項目が複数でも変更があれば1件のcompound Historyとなる。同値Paste自体はHistoryを作らず、Redoも破棄しない。Paste開始前の未確定スライダー操作は先にcommitし、そのHistoryとは別扱いにする。クリップボードも減らさない。`before`／`after`は完全recipe、metadataはsource asset ID・filenameと指定されたadjustment ID一覧を保持する。HistoryからUndo／Redoでき、表示にはコピー元filenameを使う。History compactionはPasteを前後の編集操作と結合しない。通常のdirty判定、5秒autosave、Filmstrip切替前save、Home退出時のsave・compactionを通る。

永続snapshotはRecipe v18（Recipe v17の読み込み互換あり）、`stateFormatVersion` 2（snapshot v1も読み込み互換あり）、`processingVersion` `jpeg-preview-srgb8-v1`、SQLite schema 1。snapshot v1は完全検証して読み込めるが、Paste entryはsnapshot v2にのみ許可する。v1を読むだけではDBを更新せず、その後に変更を保存するとv2になる。v2 snapshot保存後にsnapshot v1のみ対応する旧版へrollbackすると、その編集状態を読めない可能性がある。DB schema、Recipe、画素処理versionはCopy / Pasteのために変更していない。HSL、カーブ、シャープネス等は将来候補で、Copy / PasteはRecipe v18の16数値項目が対象。

## History完成後の確認・英語ロケール監査（2026-09-26・現在仕様）

History行の通常クリックはその時点のRecipeへ直接移動し、Historyを追加・削除せずRedo側を保持する。右クリックまたはShift+F10の行メニューで行う部分削除は、メニューを開いた行を基準とし、その行を含む古いHistoryを削除する。右クリック時点ではcursorを動かさない。現在位置が指定行より新しければRecipeとpendingを維持してcursorを更新し、それより古ければ指定行のafter Recipeを編集開始時としてcursorを0にする。圧縮・全削除・部分削除の直後Undoは、その写真のセッション内だけで保持する整理前EditSessionを一度復元する一時機能である。新しい編集、Redo、History移動、別の整理などで復元権は破棄または更新される。編集初期化は整理Undoの対象外である。

全履歴削除と編集初期化の確認ボタンは日本語が「キャンセル／続行」、英語が「Cancel／Continue」で、キャンセル側が初期フォーカスとなる。フォーカス中はキャンセルを赤系、続行をグレー系で強調する。Tab／Shift+TabとEnterに加えてYで続行、NまたはEscapeでキャンセルする。「この操作は元に戻せません。」（英語 “This action cannot be undone.”）と警告アイコンを表示するのは編集初期化だけ。全履歴削除は整理直後のUndoで復元できるため警告を出さない。

英語ロケール監査では、個別調整とColor Grading各調整のResetラベルを「Reset + 調整名」へ統一し、全体Reset、History部分削除、全履歴削除・編集初期化の確認文言、ギャラリーのJPEG対応説明と暗室の自動保存・Home退出時の圧縮説明を更新した。`app.title`はギャラリーのGenzoRoom見出し、`workspace.subtitle`は英語表示時の暗室見出し下で実際に使われているため維持した。日本語側への説明文追加やタイトル変更は行っていない。

ユーザーによるNAS／Firefox実機確認では、History整理の各操作と整理直後のUndoが正常に動作することを確認済み。英語UI全体のレイアウトを網羅的に確認したという意味ではない。

## 3WAY Color Grading監査（2026-09-24・現在仕様）

現在のrecipeはflat構造のv18。White Balance 2項目、Basic 6項目、Color Grading 6項目、Color 2項目の計16値と、4カテゴリ・3range・16個別項目の計23 enabled flagを持つ。各階層のON/OFFは独立し、OFFでも値を保持する。Shadows / Midtones / Highlightsは各Temperature / Tintと個別range ON/OFFを持つ。Point / Width、RAW現像、exportは未実装。

処理順はGlobal Temperature → Global Tint → Exposure → Contrast → Highlights → Whites → Shadows → Blacks → Shadows Temperature/Tint → Midtones Temperature/Tint → Highlights Temperature/Tint → Vibrance → Saturation。各range内ではTemperature適用前の同じsRGB由来Yからweightを一度計算し、Tintにも使う。range間では直前rangeの丸め済み画素からYを求め直す。

- Shadows：`1 - smoothstep(0.15, 0.35, Y)`。0.15以下でfull、0.15〜0.35でfade out、0.35以上で0。
- Midtones：`smoothstep(0.15, 0.35, Y) * (1 - smoothstep(0.60, 0.78, Y))`。0.35〜0.60でfull。
- Highlights：`smoothstep(0.55, 0.75, Y)`。0.55以下で0、0.75以上でfull。

全体OFFでは全rangeと個別項目をbypassし、ON時はcategory、range、individual flagの各段階に従う。いずれも値は保持する。個別adjustment Reset、カテゴリReset、Color Grading Resetはenabledを保持し、All Resetのみすべてtrueへ戻す。各ON/OFF切替はpending編集を先にcommitしてから独立した1操作になる。

監査で重大な整合性問題は見つからなかった。小規模修正として、Global Tintの同一R/B LUTを共用し、gain LUTとExposureも既存Float64 decode表を再利用した。linear gainのclip/encode/丸めを共通helperへまとめ、weighted TintのR/Bで同じべき乗を二度計算しないようにした。カテゴリReset・既定値判定でdefaultRecipeをキーごとに生成していた箇所も1回へ減らした。schema、gain式、weight、処理順、UI表示・操作は維持する。既存テストの画素列を用い、修正前v17の3種類の出力ハッシュを固定してbyte互換性を検証する。

Workerはsourceを初期化時に1回だけcopyしてtransferし、以後はrecipeのみ送る。runtimeは共通renderAdjustmentsを呼び、結果bufferをtransferする。1 in-flight＋pending latest 1、requestId / assetGeneration検査、fallback、unmount時の終了を確認した。sourceのmain-thread保持はfallbackに必要で、毎renderの出力bufferもsourceをdetachしないために必要。画素数に比例するCPU処理とCanvas転送は残り、Worker化だけでは進行中renderの計算時間は短縮・中断できない。今回の演算回数削減から実写真Firefoxの応答時間改善率は断定しない。

editing.tsの列挙は長いが、現在の16値・23flagのReset/equality/Historyは整合している。ColorGradingAdjustmentControlsは画素処理を持たず、6sliderの明示的な接続を保つ。AdjustmentSliderの共有MapとactiveAdjustmentは`adjustmentFocus.ts`へ分離済みで、各sliderのwindow listenerは個別の編集操作に残している。登録・解除、移動前の確定、hover/focus対象の切替は既存テストで保護する。

将来Point / Width化では、3つの純粋weight helperと定数が変更箇所になる。ただしShadows/Highlightsの片側範囲とMidtonesのplateauをどのようにPoint / Widthへ対応させるか、境界・最小幅を先に定義する必要がある。現時点のための汎用frameworkやrecipe項目は追加していない。

## UI改善 Phase 1〜3（現在仕様）

暗室のHistory／EXIF側とScope／Develop側は独立してスクロールし、調整項目間のキーボード移動は表示中のカテゴリ・3WAY範囲・スライダーに従う。スライダーには数値入力、個別電源、Resetがあり、カテゴリと3WAY範囲にも独立した電源・Reset・コンテキスト操作を備える。カテゴリ、個別調整、3WAY範囲の右クリックメニューは既存の編集actionを共有し、各ON/OFF、Reset、Copy／Pasteを行う。

ViewerのBefore／After切替はレシピやHistoryを変更せず、Backslash長押しはBeforeを一時表示する。Viewerの「⋯」メニューは開いている間グローバルshortcutを遮断し、Escapeで閉じると起動ボタンへfocusを戻す。3WAY範囲見出しから別のスライダーへ実際にポインターを移したときは古い見出しfocusを解除し、DOM focusと調整操作対象を一致させる。

HomeのRecent件数は50〜500件を50件刻みで選択できる（初期値100件）。写真グリッドはRAW／非RAW filter、Shift＋clickの表示順範囲選択、選択順を保った暗室への引き渡しを備える。HomeとFilmstripは編集済みマーカーを表示する。POST `/assets/edit-status` は最大100 IDを一括確認し、未取得・未編集・編集済みを区別する。Homeの接続状態から開く接続詳細と、Home／暗室共通のGenzoRoomタイトルを使う。暗室からのタイトル操作は既存の退出保存経路を通る。

## 総合コード監査 Phase 1〜3 完了

Phase 1では、保存結果不明時に同一snapshot・revision・saveIdを再送する処理と、discard後も確定済みの保存状態を編集済み表示へ反映する処理を修正した。HTTP 408／5xxや成功応答の解析・検証失敗は結果不明として扱い、真正な409は自動mergeしない。未保存のブラウザBack・再読込・タブ終了時の強制保存は未実装のまま。

Phase 2ではViewer「⋯」メニュー表示中のグローバルshortcutを遮断し、Escape後に起動ボタンへfocusを戻すようにした。3WAY見出しから別スライダーへ実ポインター移動した場合に残留focusを整理し、スクロール由来の疑似pointerイベントでは操作対象を変えない。

Phase 3では異常な非有限EXIF整数を欠損値として扱い、写真詳細全体の失敗を防ぐ防御を追加した。Workerのsource buffer保持・古いrender結果破棄、および3WAY各範囲内でTemperature／Tintが同じweightを共有する互換性制約を英語コメントで明確にした。Worker無応答時の回復方針は未決定で、現時点で障害が確認されたという意味ではない。総合パフォーマンス監査は未実施。

## 今後の作業計画

HistogramとWebGPUを含む暗室の実装、利用者によるNAS／Firefoxの確認は完了した。EdgeのG3暗室統合確認と総合パフォーマンス監査は未実施。将来の書き出し設定とキューはHome中心に検討し、暗室には書き出し候補のマーキングを追加する案があるが、いずれも未実装。公式サイトと日英操作マニュアルの制作時期・構成は未確定。

以前の節に記録したSettingsの構想は実装済みである。現在仕様は本ノート冒頭の「Settingsダイアログ」節を参照する。

将来のインストールガイドでは、WebGPUの動作要件、HTTPS、宅内HTTPでの制限とブラウザ固有の開発例外を説明する。例外設定は通信を暗号化せず、今回開発環境で使ったFirefoxの全体設定を一般利用者へ推奨しない。

過去の最大10/50件、古いrecipe、当時の未実装・手動検証記録は以下に保持した。今回ブラウザ手動確認やfixture・画像の作成は行っていない。

検証：Frontend 23ファイル・396テスト成功、TypeScriptチェックとVite production build成功、`git diff --check`で空白エラーなし。過去のテスト件数は各フェーズ当時の記録として残す。追加は修正前v17出力の固定ハッシュ3件とWorker起動不可・初期化失敗のfallback2件。既存latest-onlyテストもv17のrange flagを含むrecipeへ更新した。

## Color Grading / range個別ON/OFF（以前のフェーズ）

flat recipeをv17へ上げ、`gradingShadowsEnabled`、`gradingMidtonesEnabled`、`gradingHighlightsEnabled`を追加した。初期値はすべてtrue。各見出しの小型電源ボタンでTemperature / Tintの処理をrange単位で切り替える。OFFでも値を保持し、その2つのsliderをdisabled表示にする。Color Grading全体をOFFにすると3rangeすべてをbypassし、ONに戻しても個別ON/OFF状態は保持する。

各range切替は1件のHistory操作としてUndo / Redoできる。個別adjustment ResetとColor Grading Resetはenabled状態を保持し、All Resetは3rangeをtrueへ戻す。pipelineの順序、weight式、Temperature / Tint gain式、Worker protocolは変更していない。

## Color Grading / Highlights Tint（以前のフェーズ）

Color GradingのHighlightsグループへTint（色かぶり補正）を追加し、Shadows / Midtones / HighlightsそれぞれにTemperature / Tintの6項目が揃った。Highlights Tintは範囲−100〜+100、step 1、初期値0、単位なしで、負がGreen、正がMagenta。既存AdjustmentSliderとGreen→Neutral→Magenta gradientを再利用する。カテゴリOFF中も6値を保持する。

recipeはflat構造のv16で`adjustments.highlightsTint: 0`を追加した。Color Grading Resetは6値を0へ戻してenabledを保持し、All Resetは16値と4カテゴリを既定状態へ戻す。個別Reset、カテゴリReset、ON/OFF、History、Undo/Redo、Asset ID別sessionは既存方式を使う。

処理順はGlobal Temperature → Global Tint → Basic tone controls → Shadows Temperature → Shadows Tint → Midtones Temperature → Midtones Tint → Highlights Temperature → Highlights Tint → Vibrance → Saturation。Highlights TintはMidtones Tint後の画素からHighlights用Yと`weight = smoothstep(0.55, 0.75, Y)`を一度計算し、TemperatureとTintで共用する。Tint targetは`R = B = 1.3^u`、`G = 1.3^-u`、`u = highlightsTint / 100`。weight適用は`effectiveGain = targetGain^weight`。Temperature後にTintを適用し、各stageでclip・sRGB encode・8-bit丸めを行う。Shadows / Midtonesのweightおよびstageは変更していない。

この過去フェーズ節には当時のテスト件数・実行結果の詳細を記録していない。ブラウザ手動確認、fixture・画像・モックデータ作成、Commit / Pushは行っていない。

実機Firefox・実Immichでは、ハイライトのTemperature/Tint方向と0.55〜0.75のfade、Color Grading OFF中の6値保持と再適用、各Reset、History、Undo/Redo、Filmstrip切替を確認する。

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

このフェーズ当時の8-bit・ブラウザ色管理・Immich previewに依存する表示であり、原版と同等の品質やRAWのハイライト復元は保証しなかった。当時の1:1はpreviewのpixel基準で、将来JPEG originalへ切り替える際は取得adapterを差し替え、元画像とpreviewの向き・色空間・寸法を検証する計画だった。現在の原版取得・表示経路と制約は本ノート冒頭節を参照。このフェーズ当時は大画像のmain thread負荷を課題としていた。現在の画素処理はWorker経路を持つ。

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

## 11. 第三段階時点で未実装だった機能（履歴）

以下は今後の候補であり、第三段階時点では未実装。

- 写真編集画面
- RAW現像
- DNGデコード
- Exposure / Contrast / White Balanceなどの調整
- 非破壊編集パラメータを保存するDB
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

## 15. 暗室 / Anshitsuワークスペース（初期実装時）

最近の写真をクリックすると、写真ごとのURLを持つ暗室へ遷移する。暗室は将来の現像作業を行う画面で、左にHistory / EXIF、中央に写真Viewer、右上にScope、右下にDevelop controls、下にFilmstripを配置した。左側は参照情報、右側は将来のスコープ表示と現像操作の領域として役割を分けた。左右は独立して閉じられ、編集中は必要に応じてViewerを広げられる。英語UIでは名称を `Anshitsu` とし、意味を補うため `Photo development workspace` を併記する。

この段階では1枚だけを暗室へ渡すが、Frontendの遷移状態は `selectedAssets` と `activeAssetId` を分けた。将来、複数写真を持ち込んでFilmstripから表示対象を切り替える際に、同じ役割を拡張できるようにするためである。ページを直接再読み込みした場合は、URLのAsset IDから詳細を再取得する。

詳細表示画像には原画像ではなく、Immichの `GET /api/assets/{id}/thumbnail?size=preview` で生成済みpreviewを使う。GenzoRoom Backendのproxyを経由するため、Immich APIキーはブラウザへ渡らない。EXIFは `GET /api/assets/{id}` から取得し、GPSを除く主要項目だけをFrontendへ返す。欠損項目は画面に出さない。

左右パネルは独立して折りたためる。中央Viewerは初期状態をFitとし、等倍（1:1）、段階的な拡大・縮小、ホイールズーム、拡大時のドラッグPanに対応した。この初期実装時点では現像操作、Scope表示、History保存はまだプレースホルダーだった。写真の色判断を妨げないよう、暗室だけは無彩色のダークグレーから黒を基調とした。現行のHistogram Scopeは本ノート冒頭とarchitecture.mdに記載する。

### モバイル対応方針

Anshitsuはdesktop-firstとし、スマートフォン向けの本格的な現像UIは現時点の対象外とする。Viewerを十分な大きさで表示する必要があり、Scope、Develop Controls、Filmstripを同時に扱う画面は小さい画面では実用性が低いため、詳細な写真現像はPCブラウザを主対象とする。

今後もデスクトップUIの使いやすさを優先し、モバイル対応のためにデスクトップ側を妥協しない。別途明示的な方針変更がない限り、Anshitsu全体をスマートフォン向けのDrawer、Tab、縦積みレイアウトなどへ作り直さず、既存の狭幅表示を致命的に壊さない範囲の対応に留める。モバイル専用の本格現像UIも実装しない。

将来モバイル向けに、写真選択、Asset管理、RAW/JPEGのStack操作、プリセット適用、現像結果のImmich送信などの簡易操作を検討する可能性はある。ただし、これらはAnshitsuの本格現像UIとは分けて設計する。

## 16. 一覧の複数選択とFilmstrip切替

最近の写真一覧では、選択したAsset IDを配列で保持する。Setではなく配列にしたのは、最初に選んだ写真を暗室のactiveAssetにし、選択順をそのままFilmstripへ反映するためである。RAW / RAW以外フィルターは表示対象だけを変え、一覧から一時的に隠れたAssetの選択状態は解除しない。

通常状態でカード本体を押すと、従来どおりその1枚だけを暗室へ渡す。チェックから最初の1枚を選ぶと選択モードになり、以後はカード本体でも選択と解除を切り替える。Desktopでは通常時のチェックをホバーまたはキーボードフォーカス時に表示し、hoverのないモバイルではチェックを常時表示して単写真遷移と複数選択開始を分ける。

「暗室へ」では、選択順に解決した `selectedAssets` と先頭Assetの `activeAssetId` をReact Routerのnavigation stateで渡す。Filmstripで別の写真を押したときは `activeAssetId` とURLだけを切り替え、`selectedAssets` は維持する。再読み込み時にnavigation stateが失われた場合は、URLのactiveAsset 1枚をImmichから再取得する既存挙動へ戻る。

## 17. History整理メニュー（2026-09-26）

Phase 1・2の整理ロジックと一時的な整理Undoを使い、Historyヘッダーの「⋯」と履歴行の右クリックメニューを追加した。ヘッダーは圧縮・全削除・編集初期化、履歴行はこれらに「ここより下の履歴を削除」を加える。Shift+F10とコンテキストメニューキーにも対応し、通常の行クリックによる移動は維持する。

部分削除は右クリックした行を基準とする。右クリック時には移動せず、指定cursorを受け取るtrimHistoryを一度だけ実行する。現在位置が新しければRecipeとpendingを保ってcursorを減らし、古ければ指定行のafterを新しい開始時にしてcursorを0にする。この場合のpendingプレビューも含め、直後のUndoは整理前の状態全体を復元する。「編集開始時」のメニューだけは現在cursorを基準とし、cursorが0なら部分削除を無効にする。

全削除と編集初期化は日本語・英語のネイティブmodal dialogで確認する。Noを初期フォーカスとし、Tab／Shift+Tab、Enter、Y／N、Escapeに対応する。IME・AltGraph・修飾キー・リピート・処理済みのY／Nイベントを抑止し、背景のUndo／RedoとCopy／Pasteを遮断する。Yes時に写真IDと編集可否を再確認し、閉じた後は呼び出し元が再有効化されてからフォーカスを戻す。

メニューはviewport内に収める固定配置のportalとし、外側クリック・Escape・Tab・写真切替で閉じる。圧縮失敗は簡潔なalertで伝える。保存経路、圧縮アルゴリズム、各version、SQLite schemaは変更していない。ブラウザの手動確認はユーザー側のNAS／Firefoxで実施する。

## 18. STACK管理のHomeタブ統合と上下フレームUI（2026-10-09・現行仕様）

HomeのナビゲーションをRecent／Albums／Calendar／Favorites／STACK管理／出力管理の6タブに整理した。最初の4つと管理2タブの間には視覚的な間隔を設け、「暗室へ」はタブ列右側の独立した画面遷移ボタンとした。暗室はHomeへマウントせず別routeで表示する。STACK管理タブが選択されている間は暗室ボタンをdisabledにし、`D`の遷移も実行しない。Galleryの`D`は選択写真で暗室へ入り、選択なしなら既存セッションへ戻る。`S`は選択有無にかかわらずSTACK管理タブを開き、既存のHome共通ガードを通る。ショートカット説明の表示設定をOFFにしても動作は変わらない。

STACK編集セッションはHomeがメモリで所有する。Galleryの選択はSTACKタブへ入るときだけ比較し、Asset ID集合が空または前回と同一（順序違いを含む）ならdraft、Undo、STACK内の選択を保持する。初回の未選択では空状態を表示し、異なる非空集合では確認なしで新しいsession generationを開始する。新sessionは以前の未送信変更やUndoを含む一時状態を破棄し、既存の選択STACK解決・候補検出を実行する。Gallery上で選択を変えただけではdraftを更新しない。タブ切り替えと暗室往復ではHomeを維持し、STACK editorも保持する。古い取得・候補検出・送信結果はgenerationとabort制御で新sessionへ反映しない。Galleryの表示タブ、選択、filter、スクロール、および暗室復帰後の補正状態・Export Queue再取得も既存のHome所有状態として同期する。

STACK管理の表示を常時表示の上下2フレームに分けた。上がSTACK候補、下がSTACK候補外で、初期比率は2:1。ポインターキャプチャを使うseparatorで上側50〜80%（1:1〜4:1）へ調整でき、比率はHome側のメモリに置くため、タブ移動・暗室往復・同じSPA内のsession切替では保持し、reloadで2:1へ戻る。各frameは独立スクロールで、下部frame全体をStack memberのPurge drop先にした。候補外写真カード上ではカード固有dropを優先し、unmatched同士のStack作成、候補groupへのdropなど既存操作を保つ。

レイアウト調整では、STACKカードのグループ操作ボタンが共通button selectorの詳細度に負けて縮小された回帰を確認し、`.stack-management-page button:where(:not(.immich-action-button))`で一般ボタンの調整を限定して既存のアイコン寸法を戻した。Gallery基準の左右余白を設定し、Firefoxのoverlay scrollbarで右端カードに重なって見えないようframe内の右paddingとFirefox向けscrollbar設定を調整した。ChromeではSTACK内の`.visually-hidden`がbody基準の絶対配置となってdocument scroll範囲を拡大していたため、適切なframeを配置基準として外側スクロールを解消した。空の候補外frameに残っていた`min-height: 200px`はGrid行の縮小を妨げるため、最終限定監査後に削除した。写真カードとグループ自身の枠・ボタン表示、D&D領域は維持した。

StackPhotoにもGallery／Exportと同じ`FilenameDisplay`を適用し、長いファイル名は中央を省略しながら末尾と拡張子を保つ。短い名前はそのまま表示する。「Immichへ送信」は出力管理のImmich actionと共通の赤色classを使う。

監査と実機確認は別々に記録する。上下フレームUIの最終限定監査時点では**High 0 / Medium 0 / Low 1**だった。唯一のLowは空の下フレームの200px最小高さであり、直後にCSSから削除し、空・通常状態の関連テスト2件と`git diff --check`を通した。Firefox・Chromeで発生していた外側スクロールとスクロールバーの重なりは、利用者によるNAS実機確認で解消が確認された。コード上の関連Frontendテスト、TypeScript check、buildも実装段階で成功している。文書更新作業ではブラウザーやNASを操作していない。

## Filmstripの高さ調整（2026-10-17）

暗室のFilmstripがやや小さかったため、高さを10px拡大し、サムネイルの縦方向の表示領域も広げた。デスクトップのFilmstrip行は126pxから136px、狭幅レイアウトのflex基準サイズは112pxから122pxになった。サムネイル横幅92px、間隔、既存の上下パディング、Xボタン・形式・Edited／Queueバッジのサイズと配置は変更していない。ViewerはFilmstrip上部に残る高さを引き続き使用する。

手動スクロール位置の維持、ホイールによる横スクロール、写真切替・Recipe変更時の自動追従、写真切替などの操作仕様も変更していない。利用者による実ブラウザー表示確認が完了し、調整後のサイズが受け入れられた。

実装時の検証はFilmstripレイアウト関連テスト29件成功、TypeScriptチェックとFrontend build成功、`git diff --check`成功。buildでは既存の500 kB超JavaScriptチャンク警告があった。Frontend／Backend全体テストは実施していない。

## v0.2.2 リリース文書確定（2026-10-17）

v0.2.1以降のUnreleased 6項目に、Galleryの詳細画面から戻るボタンのテキスト化を加え、v0.2.2としてCHANGELOGへ確定した。収録内容は、JPEG TemperatureのWhite Balance／3WAY補正方向とグラデーションの統一、Filmstripの手動スクロール位置維持・ホイール横スクロール・高さ10px拡大、没入プレビュー中の左右キー写真移動、Filmstrip／STACK管理Xアイコン共通化、Calendar／Album詳細の戻るボタン改善。Temperatureは負値が青・寒色、0が無補正、正値が赤・暖色の相対JPEG補正で、Kelvin絶対値ではない。

Galleryの戻るボタンはカレンダー日付詳細で「カレンダーに戻る」／“Back to Calendar”、アルバム詳細で「アルバム一覧に戻る」／“Back to Albums”を表示する。矢印だけの表示をテキストへ置き換え、既存Toolbarボタンのスタイルを共有した。`closeCalendarDay`／`closeAlbum`による戻り処理と、同一タブ再クリック、選択・スクロール状態の復帰経路は変更していない。関連Frontendテスト82件、TypeScriptチェック、本番buildは成功し、buildには既存の500 kB超チャンク警告があった。実ブラウザー／NASでのこの変更の確認報告はない。

実装時に記録された検証は、Temperature CPU／3WAY／WebGPU関連Frontend 311件成功・1件skip、Backend JPEGレンダラー等10件成功、最終スライダー表示テスト72件成功。非同期`generate_thumbnail()`統合テストは停止し結果未確認。実WebGPUとTemperatureの実ブラウザー／NAS確認は未実施。Filmstrip手動スクロール関連139件、ホイール横スクロール関連146件が成功し、利用者のFirefox／NAS実機確認はPASS。高さ調整の関連テスト29件、TypeScript、本番build、`git diff --check`が成功し、利用者が実ブラウザーで調整後サイズを受け入れた。没入プレビュー操作テスト103件成功、Frontend全体実行は2,934件成功・2件skip・1件timeoutで、timeoutしたテスト単独再実行は成功。Backend全体テストは中断され結果未確認。利用者のFirefox実機確認はPASS。Xアイコン共通化時の関連Frontendテスト170件、TypeScript、本番build、`git diff --check`が成功し、後続の14px調整はFilmstrip関連33件と`git diff --check`が成功したが、その後のTypeScript/buildは未実施。利用者の最終表示確認は受け入れ済み。これら複数のbuildでは500 kB超JavaScriptチャンク警告が記録されている。

既存のCalendar date-detail限定監査はHigh 0／Medium 0／Low 1で、唯一のLow（disabled日付矢印のcursor表示）は修正済み。今回照合したリリース対象の記録に未解決のHigh／Medium指摘はない一方、全項目に独立したseverity集計が残っているわけではなく、今回新たなコード監査は行っていない。温度補正の実ブラウザー／WebGPU、`generate_thumbnail()`統合、Backend全体テスト、Gallery戻るボタンの実機確認が未検証として残る。

安定版のバージョンは`vMAJOR.MINOR.PATCH`タグから配布workflowへ渡されるため、`frontend/package.json`の`0.0.0`などを手動変更していない。v0.2.2のGitタグ、コンテナイメージ、GitHub Releaseはまだ作成・公開されておらず、CHANGELOG・設計文書の確定までを記録する。

## Phase 1C-C1限定監査 Medium修正：RAW cache cleanupと再open（2026-10-22）

監査対象・修正前HEAD `deec7121795cd1b220e8313ba3624d99fee09c9e`の限定監査結果はHigh 0／Medium 1／Low 0。open失敗後のcache cleanup timeoutで残存workerがあるのに同一workspaceの再openを受け付け、遅延cleanupが新しい原本まで削除する競合を修正した。既存の設計・C1実装記録は保持する。

変更は`backend/raw_source.py`／`windows_raw_api.py`、対応するBackendテスト2ファイル、本記録と`PHASE1C_DESIGN.md`のみ。workspaceに`active`／`releasing`／`cleanup_failed`／`empty`を保持し、回収未確認のdocument openを409で拒否する。capabilityにworkspace状態とcleanup待機状態を付加した。cacheはclose開始後のdownloadを拒否し、I/OのFuture・threadと単一cleanup taskを追跡する。先行I/O完了後に確定した所有directoryへ削除対象を固定し、timeout／cancelを成功扱いせず、同じworkerの完了を待つ。native参照解放前にcacheを削除しない保証は維持する。

workerが遅れて終了しただけでは再openを許可しない。既存DELETEで回収成功を確認し、旧workspaceを解放してから新workspaceを作成する。cache回収だけの再試行では、解放済みEngineを繰り返し再起動しない。shutdownでも未完了worker・cache・workspace所有を保持し、完了後のclose再試行で解放する。新しいAPI route、Frontend実装、JPEG処理、C2機能、LightCraft本体・versionは変更していない。

新規回帰9ケースではgate／イベントで競合順序を固定した。監査経路の再open拒否、cleanup timeout／I/O失敗／cancel、遅延directory作成、worker起動失敗、別ownerの原本保護、shutdownと回収再試行、native解放失敗時の削除禁止を確認した。Backend関連6ファイル212件成功に加え、最後に追加したnative解放失敗回帰を含むRAW APIテスト22件成功。既存FrontendのAPI client／document hook 19件も成功。既知のWindows sandbox制約を避けてrepo Python 3.14／cwd backendで権限付き実行した。全suite・Frontend buildは変更範囲上不要と判断し未実施。`git diff --check`成功。

差分と直接依存する所有・回収境界の限定再監査はHigh 0／Medium 0／Low 0。監査Mediumの再現経路は修正後に成立しないことを確認し、Windows実画面確認へ進める状態と判断した。実LightCraft／GPU／Immich、RAW原本・sidecar・既存PoC成果物は操作していない。詳細な状態遷移・API code・残る未検証範囲は[Phase 1C設計書の監査修正追記](research/lightcraft/PHASE1C_DESIGN.md#c1限定監査-medium修正cache-cleanupと再openの競合2026-10-22)を参照。README／CHANGELOGは変更していない。
## Region C2-A配送接続（2026-10-25）

C1基準 `e651a68179c91f348f9b321ea7c59a17b38ecb5b` からpublic owner、Region HTTP、共通3 lease、Frontend有限配送ownerを接続した。`useRawDocument.connectRegion()` と `regionDelivery` がC2-Bへの明示境界で、通常ViewerからRegionを要求しない。C0 schema/plannerとC1 Nativeを再定義せず、Native worker/lock/validation、manager timeout回復を共有する。WholeとRegionの予算は独立し、Recipe/History/save/P1 queueとViewer DOMを維持した。

Backend関連161件、Frontend関連332件と監査修正後のFrontend関連135件／Backend関連82件、TypeScript／production buildが成功。既存chunk警告は残る。限定監査で送信時ownerを使う取消、mutation時候補回収、document lock内のresponse lease登録を修正し、回帰確認後の未解決High/Mediumはない。実画面／実RAW/GPU／NAS/Firefox検証とoverlayは未実施。詳細なHTTP・所有状態・検証範囲・C2-B開始条件は[Region設計書§13](research/lightcraft/RAW_REGION_PREVIEW_DESIGN.md#13-c2-a完了region配送所有状態管理2026-10-25)を参照。README/CHANGELOGは変更しない。

# RAW診断JSONの保存ダイアログ（2026-10-24）

RAW Preview診断が出力する`genzoroom-raw-preview-*.json`がDesktopの`valid_name()`許可prefixに含まれておらず、WebView2の要求段階で拒否されていた。既存の文字種・長さ・`.json`・診断ページ／Blob origin検証を保ち、このprefixだけを許可リストへ追加した。許可名は既存`DownloadEvent::Requested`からWindowsのnative保存先選択を通る。

正常系でRAW名と既存origin gateを、拒否系でpath separator／実行形式・二重拡張子／Unicode／長さ超過を確認するunit testを追加。RAW測定、Frontend JSON生成、他のdownload prefix、保存IPCは変更していない。
