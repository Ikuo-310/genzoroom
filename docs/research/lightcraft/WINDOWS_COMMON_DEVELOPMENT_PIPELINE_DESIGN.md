# Windows Desktop LightCraft共通現像パイプライン設計

設計決定日：2026-11-09（Asia/Tokyo）。対象ブランチ：`feature/lightcraft-integration`。調査時の製品コード：`ab31ff7`。

**状態：Phase 1〜4実装済み。Windows Desktopでの代表JPEG縦断とRAW回帰を実機確認済み。** WindowsはRAW／JPEG等の全画像をLightCraft Nativeへ渡し、Dockerは従来JPEG現像経路を使う。実装で維持される現行契約は§10、各Phaseの変更と検証の履歴は§11にまとめる。以下の§2〜§9は実装前調査・当時の最小変更設計を残した記録であり、「今後の変更」「未実装」「未確認」の記述は調査時点のものとして読む。形式別デコーダー網羅試験や全Native受理形式を保証するものではない。

## 1. 決定事項と前回調査からの変更

Windows DesktopはLightCraft Nativeだけを現像エンジンとして使用する。Immichから取得した画像原本を変換せずNativeへ渡し、読み込み可否・処理対象フレームはNativeが決める。GenzoRoomは対応形式ホワイトリスト、拡張子／MIMEによる現像可否判定、アニメーション拒否、形式別の開放工程を追加しない。Nativeの対応追加へ入口変更なしで追随できる構成にする。

アニメーションGIFもそのまま渡す。Nativeが先頭フレームだけ処理するなら、その結果を採用する。HEIF等を現行ビルドが拒否した場合はその失敗を扱い、中間画像への変換や旧JPEG WebGPU／CPUへのFallbackは行わない。Native内部の埋め込みPreview利用もNativeの判断であり、GenzoRoom独自の救済経路は作らない。`preview_only`だけを理由に入口で拒否する現行制限も撤廃する。

Dockerは既存JPEG WebGPU／CPU経路、現像対象、保存・Export動作を維持し、Nativeを起動要件にしない。共通のGallery、STACK、Immich連携と実ファイル分類用の`is_raw`は維持する。`is_raw`をWindowsのエンジン選択へ使わず、全画像をRAW扱いに書き換えない。

前回チャットの調査案にあった「アニメーション拒否」「preview-only RAW拒否の維持」「形式群ごとの開放」「形式別実ファイル試験を受入条件にする」は今回採用しない。以前の研究記録は当時の実装・判断の履歴として保持する。新しいパイプライン、旧JPEG Recipe／Historyの移行、全面的な`raw`リネーム、不要なDB／Processing Version変更も行わない。

認証・command認可、原本保護、容量・時間制限、通信結果とNative応答の基本形状、保存データの整合性・競合処理はGenzoRoomの責務として維持する。これは対応形式の独自判定とは分離する。

## 2. 調査基準と根拠

管理基準は[manifest](../../../native/lightcraft/manifest.json)のLightCraft v0.18.1、upstream `57024f072c234e0c6c850e0940a261790f976575`。ローカルの同commit checkoutとGenzoRoom管理patch適用済みソースを読んだ。今回はNative更新、decoder仕様の再調査、build、test、probe、実機操作を行っていない。

Native側の参照は固定commitの[WB settings](https://github.com/storytold/lightcraft/blob/57024f072c234e0c6c850e0940a261790f976575/crates/develop/src/settings.rs)、[controls](https://github.com/storytold/lightcraft/blob/57024f072c234e0c6c850e0940a261790f976575/crates/develop/src/controls.rs)、[Desktop WB表示](https://github.com/storytold/lightcraft/blob/57024f072c234e0c6c850e0940a261790f976575/crates/ui-egui/src/panels/edit.rs)、[相対WB変換](https://github.com/storytold/lightcraft/blob/57024f072c234e0c6c850e0940a261790f976575/crates/ui-egui/src/panels/edit/sliders.rs)、[WB command](https://github.com/storytold/lightcraft/blob/57024f072c234e0c6c850e0940a261790f976575/crates/engine/src/cmd/develop.rs)。管理patchで追加したread-only推定は[WB契約](WB_NATIVE_CONTRACT.md)と[管理patch](../../../native/lightcraft/patches/0002-v0.18.1-native-contracts.patch)を参照する。

既存経路の背景は[統合設計](INTEGRATION_DESIGN.md)、[Native API調査](ENGINE_API.md)、[更新ガイド](UPDATE_GUIDE.md)、[v0.18.1追随記録](LIGHTCRAFT_0_18_1_UPGRADE_REVIEW.md)、[現行architecture](../../architecture.md)。これらの過去のRAW限定条件や受入件数を、今回の共通化完了の証拠に流用しない。

## 3. コードで確認した独自制限と最小変更

| 境界・根拠 | 現状の事実 | 今後の最小変更 |
|---|---|---|
| [Windows host](../../../backend/windows_local.py)、[storage](../../../backend/storage.py)、[Manager](../../../backend/lightcraft_runtime.py) | Windows hostが`/api/raw`をmountし、共通Backendのlifespanを呼ぶ。`WINDOWS_STORAGE`は起動時に設定。Managerはplatform・EXE・artifact・readyを検査 | 起動経路で決まる現像方針をreadyとは独立に共有。Queue Recoveryの前に確定する |
| [capability hook](../../../frontend/src/useRawCapability.ts)、[raw API](../../../frontend/src/rawApi.ts) | `available`のboolはDockerとWindows Native利用不能を区別しない | boolをエンジン選択に使わない。共通APIで方針を明示し、既存capabilityは現在のNative利用状態として保持 |
| [原本cache](../../../backend/raw_source.py) `get_raw_original`／`_download_file` | Asset ID、`is_raw`、`RAW_FORMATS`、拡張子、MIMEで制限 | Native用途ではRAW・形式・MIMEの可否条件を除去。認証、ID、HTTP成功、サイズ、完全性、私有cacheを維持 |
| [Immich original](../../../backend/immich.py) `get_asset_original` | JPEGのみ、または`allow_raw`かつ`is_raw`を許可。JPEG MIMEを検査 | Native用途で形式を限定せず取得できる明示オプションを既存関数へ追加し、Dockerの既定JPEG契約は維持 |
| [Session](../../../backend/lightcraft_raw.py) `_import` | `photo.inspect.kind == raw`、`preview_only == null`を必須にする | RAW限定・preview-only拒否を撤廃しNativeの画像受理結果を使う。`image`を受理。ID、寸法、content hash、応答・operation成功の検査は維持 |
| [WB controls](../../../backend/raw_controls.py)、[RAW API](../../../backend/windows_raw_api.py) | WB利用可否をKelvinとas-shotに限定。All Reset／Color Resetまで同じgateに依存 | 非RAW相対WBを利用可能にし、RAW固有のas-shot／Kelvin検査を必要な操作だけへ限定する（§5） |
| [Anshitsu](../../../frontend/src/AnshitsuPage.tsx)、[editing](../../../frontend/src/editing.ts) | `is_raw`でNative document、保存、History、Before、Queue等を切替。旧JPEGは`supportsEditing` | 現像方針による分岐へ変更。Docker用`supportsEditing`を全環境で緩和しない |
| [保存状態](../../../backend/raw_recipe_store.py)、[edit store](../../../backend/edit_store.py) `_export_saved_state` | Native Recipeがあれば採用、なければ旧JPEG状態へ戻る | WindowsはNative状態のみ選択。旧JPEGデータは移行・削除せず参照しない。Dockerは既存動作を維持 |
| [thumbnail入口](../../../backend/main.py)、[generator](../../../backend/raw_thumbnail_generator.py)、[dispatch](../../../backend/thumbnail_generator.py) | `is_raw`で保存状態・生成経路を選び、Native generatorでもRAWを要求 | WindowsはNative保存状態とgeneratorへ統一。原本取得の形式制限も同時に除去 |
| [編集済み表示](../../../frontend/src/useEditStatuses.ts)、[Gallery](../../../frontend/src/GalleryPage.tsx)、[Filmstrip](../../../frontend/src/Filmstrip.tsx) | Native状態を問い合わせるIDや履歴表示がRAWに偏る | Windowsの対象AssetすべてでNative状態を取得。STACK memberも既存の選択・順序を保つ |
| [Export store](../../../backend/export_runtime_store.py)、[Runtime](../../../backend/export_runtime.py) | Processing Versionで経路を決定。Native itemに`detail.is_raw`を要求。Retryは現在の保存状態を選択 | Admission・Snapshot・Retryの保存先方針を統一し、RuntimeのRAW原本限定を除去。Recoveryも同じ方針で検査 |
| [Native Export](../../../backend/raw_export_artifact.py)、[Registrar](../../../backend/immich_export.py) | 原本再import、settings復元、Native JPEG生成、既存`ExportArtifact`から共通登録 | 構造を再利用。形式別encoder／Registrarを追加しない |

拡張子は私有原本コピーの安全なsuffixとして保持してもよいが、許可リストやengine選択には使用しない。MIMEをNative入力形式の判定へ使わない。取得失敗の判定はHTTP状態・ストリーム完全性などで行い、200応答の内容をNativeが読めなければ読込失敗として扱う。画像のmetadata抽出失敗も画像形式非対応の根拠にしない。

## 4. 実行方針・共有状態と初期化順序（実装前調査）

**決定：** 共通Backendに小さな現像方針応答（計画上`GET /development-policy`、値`engine: lightcraft | jpeg`）を追加する。Windows起動で既に確定する`storage.WINDOWS_STORAGE`を方針の根拠として再利用し、OS推測・Frontend UA・Nativeの現在のreadyから推測しない。新しいengine plugin基盤や任意切替設定は作らない。

| 状態 | owner・更新条件 | 意味・不変条件 |
|---|---|---|
| 現像方針`engine`（未実装） | Backend起動設定。Windows storage設定後、共通lifespan／Recoveryより前に確定。実行中は不変 | Windows=`lightcraft`、Docker=`jpeg`。停止・失敗で書き換えない |
| Native capability／generation（既存） | `LightCraftManager`。起動・終了・再起動・artifact検証で更新 | 現在使用できるかを示す。方針の代用にしない |
| WB表示方式（未実装） | Native documentのkind／preview-only情報、settings、既存WB capabilityからBackendが提示。document再生成時に再評価 | 相対表示と保存scaleは別概念。Immichの`is_raw`・拡張子による判定へ戻さない |
| settings／History／revision（既存） | Native readbackと既存保存owner。confirmed operationで更新 | 永続値はNative単位。UI相対値を保存snapshotへ混入しない |
| Queue frozen Recipe（既存） | Export store。Startのtransactionで確定 | run中は不変。Retryは最新保存状態を再選択し、Recoveryは既存凍結値を使用 |

既存storage設定はpersist consumerをimportする前に実施する制約がある。方針を追加するときも、共通lifespanがExport Runtime／schedulerを構築しRecoveryを始める前に参照可能にする。Manager開始後にのみ方針を設定する設計にはしない。storeは同じ起動方針を参照し、recipeの有無や`available`で別方針へ戻らない。

Frontendは方針取得中・取得失敗をDockerとみなさない。編集は待機／エラーにし、閲覧・Gallery等は維持する。WindowsでNativeが停止しても方針は`lightcraft`のまま、PVに利用不能を表示する。

## 5. WB：公式Desktopと同じ表示、Native値の保存

### 5.1 コードで確認した契約

Native `WhiteBalance`のdefaultは`mode: asShot, temp: 6500, tint: 0, scale: legacy`。`legacy`はJSONで省略される場合がある。`scale: legacy`はUIの−100〜+100値を保存するという意味ではない。現行Nativeの`wb.temp` controlは2000〜50000、default 6500、step 50、`wb.tint`は−150〜+150、default 0、step 1。既存RAWアダプターはこのcontrol範囲を使う。

公式Desktopは通常の画像に別の表示spec `wb.tempRel`／`wb.tintRel`を使用する。両方−100〜+100、default 0、step 1、整数表示。これらは表示用IDであり、Native更新には既存`wb.temp`／`wb.tint`を使う。

| 操作・表示 | 公式Desktopの契約 | GenzoRoomで採用する境界 |
|---|---|---|
| 相対色温度の表示 | `r = clamp((1e6 / 6500 - 1e6 / temp) / 0.8, -100, 100)` | Native readbackから表示時だけ変換。中央0はtemp=6500 |
| 相対色温度の入力 | `temp = 1e6 / (1e6 / 6500 - 0.8 * r)` | 表示値をNative値へ変換して`develop.set`へ送信。−100は約4276.316、+100は約13541.667 |
| 相対Tint | 表示は`clamp(tint, -100, 100)`、入力値を`wb.tint`へ直接送る | 倍率変換なし。Native保存範囲−150〜+150を維持 |
| 色温度track | 左が寒色、右が暖色 | 既存`TEMPERATURE_TRACK_GRADIENT`（青→中立→オレンジ）を再利用 |
| Tint track | 負がgreen、正がmagenta | 既存`TINT_TRACK_GRADIENT`を再利用 |
| Auto／Pick | read-only推定がmode／scale／temp／tintを返す。候補tempは2000〜50000、tintは−150〜+150 | 既存candidate検査とidentity fenceを再利用し、候補をNative単位で適用 |

UI範囲を超えるNative候補を受け取った場合、公式Desktop同様に表示のみclampする。表示しただけで値をclampして保存したり、Auto／Pick後に表示値を逆変換してNativeへ再適用したりしない。実際に利用者がスライダー／数値欄を編集した場合だけ、その表示値からNative更新を作る。相対温度の変換後にRAW用step 50で丸めない。

### 5.2 決定した実装境界

RAWの既存Kelvin表示・WB操作・スポイトを維持し、Nativeが通常画像／相対WBとして扱うdocumentは公式Desktopと同じ相対表示にする。RAWの特殊なrelative／preview-only状態もNativeの意味に従い、RAWという分類だけでKelvinを強制しない。現在のNative metadataだけで曖昧なケースは表示能力の取得境界で扱い、GenzoRoomでcamera matrixや形式一覧を解釈し直さない。

Backend controlsの値・更新API・Recipe・History snapshot・ExportはNative単位を維持する。相対変換はFrontendのWB表示／入力境界で一度だけ行い、`RawAdjustmentControls`と`RawEditHistory`の値表示で共有する。Historyの差分値自体を書き換えず、そのstepのNative settingsと表示方式に合わせてformatする。スライダー、数値入力、focus／gestureは既存`AdjustmentSlider`を再利用し、旧JPEG reducer／Recipeを経由しない。

`wb.available`、`wbAutoAvailable`、`_wb_available`、`as_shot_wb`の現行Kelvin限定を分離する。非RAWはWBを利用可能とし、`wb.scale`はNative readbackを保持する。`raw_white_balance.validate_candidate`は既に`kelvin`／`legacy`両方とNative範囲を受理するため、その検査を相対表示範囲へ狭めない。

Resetは既存Native `develop.wb(mode: asShot)`、section／all resetを再利用する。現行`apply_operation`の「as_shot_wb必須」「reset結果はscale=kelvinかつas-shot値に一致」というRAW用前提はKelvin documentだけへ限定する。非RAWでAll Reset／Color ResetがWB gateにより拒否されないよう修正し、Native reset後readbackを保存する。スポイト座標、Before／After identity、mutation後History確定の順序は維持する。

## 6. Viewer・永続化・サムネイル・Export

### 6.1 FrontendとViewer

WindowsではAssetの`is_raw`にかかわらず既存`useRawDocument`へ接続する。`useJpegOriginal`の原本取得、旧JPEG renderer／GPU owner、旧JPEG edit-state読込・保存・clipboardを起動しない。`AnshitsuPage`のHistory、Undo／Redo、Reset、Before、切替・退出、保存Retry／Discard、Q操作を同じ方針で切り替える。

Native Whole／Before／Region／Geometry／curveの既存契約とImageViewerを再利用する。形式別ViewerやPreview変換を追加しない。Native利用不能・拒否時に`activeDetail.preview_url`や旧JPEG Originalへ切り替えて現像成功に見せない。Gallery／通常閲覧用のImmich thumbnailを維持することとは区別する。

### 6.2 Recipe／History／編集済み表示

既存`raw_recipe_store`とHistory owner、source content hash、saveId、revision、fingerprint、競合・Retryを再利用する。`raw-lightcraft-v1`はNative設定経路の識別子として維持する。入力拡張子を識別子へ埋め込まない。Recipe／Historyのschema変更・旧JPEGデータの変換は不要。

WindowsでNative保存状態がなければNative import defaultsから開始し、旧JPEG状態へ戻らない。Gallery／STACK member／Filmstrip／Anshitsuの編集済みstatusはNative保存状態に揃える。写真分類・STACK cover選択・Trash保護に使う`is_raw`は残す。

### 6.3 サムネイル

Windowsは保存状態の確認と生成dispatchをNative経路へ揃える。独立した既存Native processで原本をimportし、保存settingsを復元して小さいPreviewを生成し、既存JPEG thumbnail cacheへ格納する。これは表示cacheの生成であり、入力救済用の中間画像ではない。編集Sessionは変更しない。

保存通知、Reset時のcache無効化、古い生成結果を公開しないpublication fenceを維持する。`is_raw`によるgenerator gateと原本取得gateを除く。DockerのJPEG generatorと保存状態確認は変更しない。

### 6.4 Export QueueとImmich

WindowsのAdmission、Start Snapshot、RetryはNative保存状態だけを選択する。非default判定・transaction・Queue順序・stop／retry／recovery ownerは再利用する。Start後の編集で凍結Recipeを変えず、Retryは最新保存状態、Recoveryは既存凍結状態という現行契約を維持する。

Runtimeの`detail.is_raw`検査と原本取得のJPEG／RAW制限を外し、Native artifact生成へ渡す。原本は一時コピーだけを公開し、XMP autoWrite無効化とprocess終了後cleanupを維持する。Nativeが拒否したらitemを失敗にし、旧JPEG処理へ回さない。

旧Windows JPEG runが残る場合も旧engineを実行しない。実行方針と異なるProcessing Versionを明示エラーとして既存run／item状態へ記録し、移行や自動再解釈を行わない。DockerにNative snapshotが持ち込まれた場合もNative起動で救済しない。新しいQueue／DBは作らない。

現行`export_raw_artifact`のNative import→settings復元→sRGB 8bit JPEG出力→EXIF／XMP再構成→`ExportArtifact`→既存`ImmichExportRegistrar`を再利用する。Native JPEGを再圧縮しない。Tag、Favorite、STACK COVER、Album union／非COVER正規化は共通経路を維持する。metadataの任意抽出ができない場合の既存warn継続を維持し、metadata不在を画像非対応とは扱わない。

## 7. Native拒否・PVエラー・Session lifecycle

**現状：** `_import`はfailedのある結果を`raw_import_failed`へまとめ、MCPの一般tool失敗も`lightcraft_tool_error`へ集約する場合がある。`raw_unsupported_source`には現行のkind／preview-only／応答検査も混在する。このcodeをそのまま「形式非対応」の証拠にはできない。Native importのfailed情報はpathと文字列理由を含むため、そのままPVやログへ出さない。

**決定：** 既存エラー経路へ必要な分類だけ追加する。Nativeが明確な非対応理由を返し、安全に分類できた場合にのみ「未対応の画像形式です」を表示する。生のエラー文の広範なsubstring照合や形式一覧の逆算は行わない。現在の契約で区別できないimport／decode失敗は「画像を読み込めませんでした」等の一般エラーとし、Native contract追加を共通化完了の前提にしない。

| 境界で確認できる失敗 | PV・操作の扱い |
|---|---|
| Native未導入・起動失敗・artifact不正・process終了 | Native利用不能／起動・接続失敗として表示。方針はlightcraftを維持 |
| Immich認証・原本取得失敗 | 認証／取得失敗を表示。Nativeへ不完全な原本を渡さない |
| 既知のNative形式非対応 | 形式非対応を表示。中間変換・別engineへの再送なし |
| 破損と判明した画像 | 破損／読込失敗を表示。形式非対応に置換しない |
| 原因不明のimport／decode失敗 | 一般読込失敗。サイズ超過・通信・契約不正を区別できる場合はそのcodeを優先 |
| Preview／Region失敗 | 既存の表示失敗／Retryを使用し、別engineの画像を採用しない |
| Export失敗 | 既存Queue item失敗とRetryへ接続。Preview成功だけで完成扱いしない |

document open失敗時は、既存`RawPreviewApi`の`_release`経路でNative処理を終了してから所有cacheを削除する。Native importは部分的にcatalogを変えている可能性があるため、失敗したdocument／古いhandleを編集可能状態で公開しない。新しいRecipe／Historyは作らず、以前の保存済み状態は保持する。既存の保存前切替guard、generation／document token、stale frame排除は維持する。

PVには失敗状態を保持し、明示Retryまたは別Assetへの切替を可能にする。失敗後に別の受理可能な画像を開けることを最小回帰に含める。再importは既存Session再生成を使い、並列Session・自動形式probe・別engine fallbackを追加しない。Native本文、原本パス、Recipe本文をログへ出さず、既存の安全なerrorCode／phase／generation等で診断する。

## 8. 実装Phaseと受入条件（実装前計画）

4 Phaseを維持する。各Phaseをreview可能なCommitへまとめ、形式別開放には分割しない。Phase 1〜3の内部工程完了と、共通化全体の受入完了を区別する。

### Phase 1：現像方針の分離

- **変更対象：** `backend/storage.py`、`backend/main.py`、`backend/windows_local.py`、`backend/windows_raw_api.py`、`frontend/src/rawApi.ts`、`frontend/src/useRawCapability.ts`、方針取得の小さなFrontend hookと対応tests。既存起動設定を再利用できる部分は変更しない。
- **依存・実装：** 起動方針APIと利用状態を分離。Windows設定が共通lifespan／Recoveryより先に確定する。Frontendは未取得・失敗をDockerへ解釈しない。Phase 2／3が共通の方針を使える契約を作る。
- **最小回帰：** Windows ready／not-ready／failedでも方針不変、Dockerはjpeg、方針取得失敗で旧engineを選ばないこと。既存startup／capabilityテストへ追加。
- **Windows実機受入：** Native起動失敗でもWindows方針のまま状態を表示し、Galleryが利用できる。JPEG共通化はまだ完了としない。
- **Docker影響：** 方針応答の追加のみ。Native processやartifactを要求しない。

### Phase 2：Backend共通化

- **変更対象：** `backend/raw_source.py`、`backend/immich.py`、`backend/lightcraft_raw.py`、`backend/raw_controls.py`、`backend/windows_raw_api.py`、`backend/raw_white_balance.py`（必要なadapter変更のみ）、`backend/raw_recipe_store.py`（必要箇所のみ）、`backend/edit_store.py`、`backend/main.py`、`backend/thumbnail_generator.py`、`backend/raw_thumbnail_generator.py`、`backend/export_runtime.py`、`backend/export_runtime_store.py`、`backend/raw_export_artifact.py`と関連tests。
- **依存・実装：** Phase 1の方針を使用。原本取得からimportまでの形式・MIME gate、RAW限定kind／preview-only拒否を除去。Native単位WB・Reset／Pick、Native保存状態選択、thumbnail、Admission／Snapshot／Retry／Recovery、Exportを接続する。Registrarの既存境界を維持。
- **最小回帰：** 既存RAWとNative `kind:image`、未知suffix／異なるMIMEでも原本バイトをそのまま渡すこと、Native拒否とcleanup・次のopen、相対WB候補／Reset、保存・復元・競合、thumbnail fence、凍結・Retry・異方針run拒否を既存test群で確認。形式を列挙したfixture群は不要。
- **Windows実機受入：** 代表JPEGのAPI経由open・編集・保存・再読込・thumbnail・JPEG Exportが同じNative設定で成立し、原本不変。最終UI受入はPhase 4。
- **Docker影響：** original既定契約、JPEG保存状態・Exportを維持。Native専用オプションをDocker経路へ流さない。

### Phase 3：Frontend共通化

- **変更対象：** `frontend/src/AnshitsuPage.tsx`、`frontend/src/useRawDocument.ts`、`frontend/src/rawApi.ts`、`frontend/src/RawAdjustmentControls.tsx`、`frontend/src/RawEditHistory.tsx`、`frontend/src/useJpegOriginal.ts`、`frontend/src/useEditStatuses.ts`、`frontend/src/GalleryPage.tsx`、`frontend/src/Filmstrip.tsx`、必要なQueue表示・翻訳・関連tests。既存`AdjustmentSlider`／WB gradientを再利用し、相対WB境界helperは小さく共有する。
- **依存・実装：** Phase 1／2が前提。全Windows画像を既存Native documentとUIへ接続。相対WB表示・入力・History format、Before／After・Region・Geometry、保存・切替・退出・Queue、編集済み表示、PVエラーを統一する。旧JPEGの取得・保存・rendererを対象経路で起動しない。
- **最小回帰：** Windows非RAWにもNative documentが生成され旧JPEG ownerが起動しないこと、方針取得／Native失敗、WB往復・中央0・両端・表示clampでsettings不変・RAW Kelvin維持、History／Reset／保存失敗とRetry、Before／Regionと切替、Queue・編集済み表示。既存React integrationと型チェック・production buildを使用。
- **Windows実機受入：** 代表JPEGで既存LightCraft現像UI、相対WB、スポイト、History、Reset、保存復元、PVエラー／Retryを操作可能。Exportを含む最終受入はPhase 4。
- **Docker影響：** 既存JPEG UI／WB／GPUとCPU経路を選択し、保存・Queueを維持。

### Phase 4：縦断確認・安定化

- **変更対象：** 関連Backend／Frontend統合tests、必要なら既存Native smoke／probeの代表画像接続、発見した不具合箇所と設計記録。新しい形式別suite・全decoder監査は作らない。
- **依存・実装：** Phase 1〜3完了後、JPEGを代表として原本取得→Native import→Preview／編集→History／Recipe保存・復元→thumbnail→Queue Snapshot→Native JPEG→実Immich登録を確認し、見つかった接続不具合を修正する。
- **最小回帰：** 上記縦断と既存RAW・Docker JPEGの関連tests。Native失敗・原本取得失敗、保存Retry、run中編集とsnapshot不変、Export失敗とRetry、登録後STACK／Albumを対象にする。既に成功した同一コードの結果を再利用し、全suiteは具体的な依存リスクがある場合だけ理由を示して追加する。
- **Windows実機受入：** 代表JPEGで読込・Full Preview・WB／スポイト・Geometry等の編集・Before／Region・Undo／Redo・Reset・保存後再起動復元・thumbnail・Export・Immich登録が成立する。Native停止／拒否時はPVで適切なエラーとなりFallbackしない。失敗後に別画像を開け、既存RAW Kelvin／スポイト／保存・Exportが維持される。STACK／AlbumはGalleryだけでなくImmichの実membershipも確認する。
- **Docker影響：** JPEGの既存UI・保存・Preview・Export／登録を回帰確認し、Nativeなしで起動する。routine full Docker release Smoke Testは行わない。

**完成条件：** JPEGの代表縦断、既存RAW、Docker JPEGの必要な回帰を満たし、Windows実機受入の結果を自動テストと区別して記録する。PreviewだけでExport／登録できない状態は完成ではない。一方、JPEG以外の形式別実ファイル試験、全機種RAW、画質比較、全decoder仕様の独立検証は完成の必須条件ではない。

## 9. 未確認事項・当時の検証範囲

- 当時の調査では共通化機能は未実装で、WB数式・範囲・Reset gateはソース確認のみだった。後続実装とWindows受入の結果は§11を参照。
- Native importの拒否理由は現行adapterで情報が集約される。安全に形式非対応を確定できないケースは一般読込失敗とする。エラーcodeの最終命名は既存schema・翻訳に合わせて実装時に決める。
- RAWの特殊なrelative／legacy状態についてNativeから取得できる表示能力の形を実装時に確認する。非RAWには確認済みの公式相対表示を適用し、この確認を形式別開放工程へ拡大しない。
- 実Immich、Windows実機、Native JPEG縦断、Docker実環境の受入はPhase 4の未確認項目。今回形式別試験やブラウザ操作は行っていない。
- 上記は設計確定時の記録である。後続の実装・テスト・手動検証は§11に追記した。

## 10. 現行実装仕様

Windows DesktopはBackend起動時に確定する`development-policy`（`lightcraft`）を現像経路の基準とする。Dockerは`jpeg`を使う。Nativeの利用可能状態は別管理で、方針取得失敗やNative停止をJPEG fallback条件にしない。`is_raw`は写真分類、STACK、Trash等に残し、Windowsの現像エンジン選択には使わない。Windowsは旧JPEG Recipe／Historyを自動移行・削除しない。GenzoRoom独自の形式allowlistを設けず、原本をNativeへ渡し、受理可否はNativeに委ねる。拒否時はPVに失敗を表示し、旧JPEG engineや中間変換へ切り替えない。

Windows DesktopとDockerは独立したデータベースを使い、Recipe、History、編集状態を共有・移行しない。Galleryの編集状態取得も同じ方針に従い、WindowsはRAW／非RAWともNative状態を使う。DockerはJPEG状態APIのみを呼び出し、RAW素材とRAWを含むSTACK memberは未編集として扱う。JPEG状態取得に失敗した場合は未編集ではなく状態不明とする。

Windowsでは既存Native Sessionを非RAW画像にも共通利用する。Preview／適応解像度、各調整、WB／AWB／スポイト、ポイントカーブとターゲット調整、Geometry、History／Undo／Redo／Jump、Recipe保存・復元、編集済みサムネイル、Queue Exportを同じ経路で扱う。RAW固有のas-shot情報やKelvin利用可否はNativeが示す設定・capabilityに従う。`raw`を含む既存ファイル名・API・識別子は残り、今回の全面リネームは行っていない。

WB Recipe／HistoryはNative値を保持する。非RAWの`legacy` WBはDesktop相対表示（−100〜+100、中央0）を使い、表示変換はUI境界に限る。RAW Kelvin表示・操作を維持する。Nativeの既定`wb.scale: legacy`はreadback JSONで省略されることがある。Export設定比較では比較用に限って省略を`legacy`として扱う。Recipe値、Native送信値、保存snapshotは書き換えず、明示Kelvinや他の設定不一致は拒否する。

Export Queue開始時に保存RecipeとRevisionを固定し、原本hashを照合してNativeへ原本を渡す。Recipeをreset／mergeで復元し、Export前後のsettings readbackを検証してからNative JPEG Artifactを確認し、既存Immich Registrarへ渡す。診断には安全なphase、errorCode、exceptionTypeを使用し、原本パス、Recipe値、認証情報、画像内容を記録しない。WindowsサムネイルはNative Recipe／generator、DockerサムネイルはJPEG Recipe／generatorを使う。Native Retryは登録後続処理の失敗時に再生成となり、重複出力が生じ得る（既知R-01）。重複登録防止は実装済みではない。

異方針の保存済みExport runは`unsupported_processing_version`で失敗させ、原本取得や異なるengineのArtifact生成へ進めない。Recipeを変換・削除せず、既存run／Queueの失敗状態を記録する。

## 11. 実装・検証の完了記録

- **Phase 1：方針分離** — Backendの`development-policy`でWindows=`lightcraft`／Docker=`jpeg`を公開し、Native capabilityと分離。Frontendは方針取得失敗をDockerとして扱わない。
- **Phase 2：Backend共通化** — Windows Native原本取得、Session、Native WB、Recipe／History、サムネイル、Exportへ非RAWを接続。Docker JPEG経路を維持。
- **Phase 3：Frontend共通化** — Windowsは`is_raw`によらずNative暗室、Preview、WB、History、Recipeへ接続。Legacy WB表示とKelvin表示をNative scaleで切替。
- **Phase 4：縦断確認** — ユーザー報告によるWindows実機でJPEGの読み込み、編集、保存、Native Export、Immich登録成功を確認。RAW／DNG Export成功、STACK登録も確認。Native未対応形式を全件試験したものではない。
- **F-01/F-02** — Docker JPEG方針を明示するFrontend test fixtureへ修正。保存Recipe選択、異方針runの原本取得前拒否、Windows／Docker thumbnail dispatchを方針ベースに統一。
- **自動検証** — 直近修正のFrontend Persistence 76件、Backend Runtime／Thumbnail関連69件、Backend Queue／Retry等を含む175件、TypeScript、`git diff --check`が成功。これは自動テスト結果で、Windows／Docker手動受入とは分ける。
- **手動受入** — Windows JPEG Export／Immich登録とRAW/DNGの成功はユーザー報告。Docker実環境のNative不在起動・実際のJPEG編集／Exportを今回の自動検証から推定しない。
- **統合後Docker実機確認（ユーザー報告）** — Portainerで`main`から再ビルドし、起動、Immich接続、サムネイルプレビュー、JPEG現像・Export、RAW編集不可を確認。これは今回の自動テスト結果とは別の実機受入である。
