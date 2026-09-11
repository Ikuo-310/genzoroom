# GenzoRoom 開発ノート

## JPEG Exposure / Contrast / Highlights / Whites / Shadows / Blacks編集基盤（最新フェーズ）

JPEGのみを対象に、露光量 −5〜+5 EV（0.01 EV刻み、初期値0）、コントラスト・ハイライト・ホワイト・シャドウ・ブラック −100〜+100（1刻み、初期値0）の調整を追加した。RAW/DNG・HEIC処理、Backend、DB、永続保存、Immich書き戻しには変更を加えていない。

編集はAsset IDごとのメモリ上のsessionで保持する。recipeを `{ version: 6, basicEnabled: true, adjustments: { exposure: 0, contrast: 0, highlights: 0, whites: 0, shadows: 0, blacks: 0 } }` とし、Historyは操作種別・変更前後recipe・cursorを持つ。Filmstrip切替では各Assetの状態を保持し、暗室を離れるかリロードすると消える。各個別Reset、基本補正ON/OFF、基本補正Reset、All Resetは別の操作種別で、いずれもUndo可能。基本補正Resetは有効状態を維持して6項目だけを1操作で0へ戻す。All Resetは6項目を0へ戻し、`basicEnabled`も既定値trueへ戻す。Historyでは基本補正ON/OFF、基本補正Reset、All Resetを簡潔な1件として表示する。将来永続化する際はversion 5以前のrecipeへ `basicEnabled: true` を補い、それ以前のversionについては各必須adjustmentも段階的に補うmigrationが必要になる。

操作開始時のrecipeをpendingに保持し、操作中はcurrent recipeだけを更新する。ドラッグ終了/cancel、コントロールのunmount、キーボードまたはwheel入力停止500msでcommitする。キーボードとwheelでは受理した入力ごとにtimerをresetし、keyup、pointer leave、focus移動では早期commitしない。細かな入力はHistoryに積まず、同値へ戻る操作も履歴を作らない。Undo後に新しい変更をcommitした場合だけRedo側を破棄する。

共通AdjustmentSliderはホバーまたはフォーカス中に左右1 step・上下10 stepで操作できる。range上のwheelはdeltaYの符号だけを使い、上方向を+1 step、下方向を−1 stepとして扱う。実際に値が変わったwheelだけを`preventDefault`し、境界、deltaY=0、disabled、number入力やslider外のwheelは通常のscrollへ渡す。別のrangeにフォーカスしている場合はそのrangeを優先する。テキスト入力、textarea、select、contenteditable、IME変換中は独自ショートカットで操作を奪わない。Ctrl/Cmd+Z、Ctrl/Cmd+Shift+Z、Ctrl/Cmd+Yと画面ボタンを用意した。

現像項目を増やす前提で、AdjustmentSliderをラベル・range・直接数値入力・任意の単位・小型個別Resetが横並びになる1行グリッドへ整理した。6項目は「基本補正」カテゴリ内へ配置し、カテゴリ見出しから折り畳み、ON/OFF、6項目一括Resetを操作できる。折り畳み状態はUIローカルで毎回展開から始まり、recipeへは保存しない。OFF中は値を保持したままpipelineをバイパスし、内部controlをdisabled・dim表示にする。暫定preview注釈はカテゴリ外にあるため、折り畳みやOFFに関係なく表示する。重複していたスライダーのキー操作説明はパネルから削除した。

ラベル列は長い場合に省略し、range列が右サイドバーの残り幅へ追従する。単位は空でも固定幅を予約してslider端を揃え、数値欄は44pxとした。Exposureは −5〜+5 EV、0.01 EV刻み、表示2桁、Contrast・Highlights・Whites・Shadows・Blacksは −100〜+100、1刻み、整数表示。直接入力中は有限値をstepと範囲へ正規化してcurrent recipeへ反映し、Enterまたはblurでcommit、Escまたは空・無効入力で編集開始値へ戻す。編集中だけdraft文字列を表示し、確定後はslider、ホバーキー、Reset、Undo/Redoなど全経路のrecipe値へ即時追従する。number入力中のカーソルキーは既存のホバースライダー操作から除外する。個別Resetは既定値0のときdisabledにし、All Resetは個別Resetと区別できるようDevelop Controls見出し右端へ配置する。

画像取得はeditImageSourceに隔離し、今回はImmich previewを暫定入力にした。`basicEnabled`がfalseなら未変更sourceを返し、6項目の値は書き換えない。有効時はブラウザでsRGB RGBAへdecodeし、まずsRGBの伝達関数を戻した線形光へ2^EVを乗算してsRGBへ戻す。その後、各sRGB channelを0.5中心に `1 + contrast / 100` 倍して0〜1へclipする。HighlightsはsRGB輝度 `Y = 0.2126R + 0.7152G + 0.0722B` から0.5〜1.0のsmoothstep重みを求め、正値では `1 - (1 - Y)^2`、負値では `Y^2` へ補間する。WhitesはHighlights後の輝度0.75〜1.0をsmoothstepで選び、正値では1.0、負値では0.75へ補間する。ShadowsはWhites後の輝度から0〜0.15のsmoothstep重みを求め、正値では `sqrt(Y)`、負値では `Y^2` へ補間する。BlacksはShadows後にMaster Black / Pedestalとして、`weight = 1 - smoothstep(0, 0.35, Y)`、`newY = clamp(Y + blacks / 100 × 0.10 × weight, 0, 1)`を適用する。作用は黒で最大、0.10〜0.20でも明確に残り、0.30付近で弱まり、0.35で連続的に0になる。非ゼロ輝度には目標輝度と元輝度の比をRGB共通倍率として適用し、倍率では持ち上げられない完全な黒だけは色相が定義されないため無彩色として扱う。Shadowsは暗部階調を曲線で起こす／沈める操作、Blacksは低域全体の基準レベルを加算offsetで上下する操作として分けた。alphaを維持し、毎回未変更の画素bufferからExposure → Contrast → Highlights → Whites → Shadows → Blacksの順に計算するため累積劣化しない。requestAnimationFrameで更新をまとめ、Canvasだけを書き換えるのでViewerのZoom/Panは編集値変更で初期化されない。

8-bit・ブラウザの色管理・既存previewに依存する暫定表示であり、originalと同等の品質やRAWのハイライト復元は保証しない。現在の1:1もpreviewのpixel基準。将来JPEG originalへ切り替える際は取得adapterを差し替え、元画像とpreviewの向き・色空間・寸法を検証する。大画像のmain thread負荷は別途評価し、必要が出てからWorker等を検討する。

DB導入時はrecipe versionの検証/migration、Assetと入力画像・処理versionの紐付け、commit時の原子的保存を設計する。previewベースのレシピをoriginalへ無条件に適用して同じ見え方になるとは扱わない。pending操作やCanvas bufferは永続化対象にせず、Historyを保存するかは別に決める。

以下は過去フェーズの記録であり、当時の「未実装」の記述を含む。

検証：Frontend 159件のテストおよびproduction buildが成功。純粋画素テストではBlacks 0 / +100 / −100、0.10〜0.20の明確な作用、0.30付近の弱い作用、0.35以上の不変、完全黒のlift、色付き暗部のRGB構成比、他5補正との処理順に加え、基本補正OFF時の完全bypassと値保持を確認した。UIテストではカテゴリの初期展開・折り畳み・再展開、OFF中のcontrol無効化、ON/OFFとカテゴリResetとAll ResetのUndo/Redo・簡潔なHistory、カテゴリ外の暫定注釈を確認した。ローカルの640×360グラデーションfixtureを使うChromium確認では、基本補正のOFF・値保持・control無効化、折り畳み・再展開、カテゴリReset、Undo/Redo、All Reset、History、操作説明の削除、カテゴリ外の暫定注釈を確認した。右パネル230 / 350 / 440pxではカテゴリに横overflowがなく、range幅は約41 / 138 / 228pxへ追従し、ページにも横overflowは発生しなかった。再読み込み後はカテゴリが展開状態から始まり、右パネル幅は保持された。Chromiumではrange上のwheelでExposureが1 eventにつき0.01 EV変化し、500ms後に1件だけHistoryへcommitされること、range外では右パネルが通常scrollし、Basic OFF中のrange wheelは値を変えず通常scrollへ渡ることを確認した。既存自動テストで直接入力、hover/focusキー操作、keyboard/wheelの500ms commit、個別Reset、Viewer、Sidebar resize、Filmstrip、multi-select等の回帰を確認している。実Immich/NAS接続、実写真の色再現、大画像の性能、Firefoxは今回未検証。Backendは未変更で、Backendテストは今回再実行していない。

この文書は、GenzoRoomの第三段階までに行った実装、実機確認、設計判断、トラブルシュートを後から振り返るための内部向けメモである。公開リポジトリに置くため、APIキーなどの秘密情報は記録しない。

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

## 11. 現時点で未実装

以下は今後の候補であり、第三段階時点では未実装。

- 写真編集画面
- RAW現像
- DNGデコード
- Exposure / Contrast / White Balanceなどの調整
- 非破壊編集パラメータを保存するDB
- Histogram
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

最近の写真APIが返した最大50件のAssetに対し、Frontendが `is_raw` を使って表示だけを絞り込む。フィルター変更時にBackendやImmichへ再取得せず、取得件数と検索条件も変更しない。

RAWとRAW以外の2つのチェックボックスは初期状態で両方ONとし、片方だけがONになった場合は最後のチェックを外せないようにした。フィルター結果が0件の場合は、Immichからの取得結果自体が0件の場合とは別のメッセージを表示する。フィルター状態は保存せず、再読み込み時には両方ONへ戻る。

## 15. 暗室 / Anshitsuワークスペース

最近の写真をクリックすると、写真ごとのURLを持つ暗室へ遷移する。暗室は将来の現像作業を行う画面で、左にHistory / EXIF、中央に写真Viewer、右上にScope、右下にDevelop controls、下にFilmstripを配置した。左側は参照情報、右側は将来のスコープ表示と現像操作の領域として役割を分けた。左右は独立して閉じられ、編集中は必要に応じてViewerを広げられる。英語UIでは名称を `Anshitsu` とし、意味を補うため `Photo development workspace` を併記する。

この段階では1枚だけを暗室へ渡すが、Frontendの遷移状態は `selectedAssets` と `activeAssetId` を分けた。将来、複数写真を持ち込んでFilmstripから表示対象を切り替える際に、同じ役割を拡張できるようにするためである。ページを直接再読み込みした場合は、URLのAsset IDから詳細を再取得する。

詳細表示画像には原画像ではなく、Immichの `GET /api/assets/{id}/thumbnail?size=preview` で生成済みpreviewを使う。GenzoRoom Backendのproxyを経由するため、Immich APIキーはブラウザへ渡らない。EXIFは `GET /api/assets/{id}` から取得し、GPSを除く主要項目だけをFrontendへ返す。欠損項目は画面に出さない。

左右パネルは独立して折りたためる。中央Viewerは初期状態をFitとし、等倍（1:1）、段階的な拡大・縮小、ホイールズーム、拡大時のドラッグPanに対応した。現像操作、Scope表示、History保存はまだプレースホルダーである。写真の色判断を妨げないよう、暗室だけは無彩色のダークグレーから黒を基調とした。

### モバイル対応方針

Anshitsuはdesktop-firstとし、スマートフォン向けの本格的な現像UIは現時点の対象外とする。Viewerを十分な大きさで表示する必要があり、Scope、Develop Controls、Filmstripを同時に扱う画面は小さい画面では実用性が低いため、詳細な写真現像はPCブラウザを主対象とする。

今後もデスクトップUIの使いやすさを優先し、モバイル対応のためにデスクトップ側を妥協しない。別途明示的な方針変更がない限り、Anshitsu全体をスマートフォン向けのDrawer、Tab、縦積みレイアウトなどへ作り直さず、既存の狭幅表示を致命的に壊さない範囲の対応に留める。モバイル専用の本格現像UIも実装しない。

将来モバイル向けに、写真選択、Asset管理、RAW/JPEGのStack操作、プリセット適用、現像結果のImmich送信などの簡易操作を検討する可能性はある。ただし、これらはAnshitsuの本格現像UIとは分けて設計する。

## 16. 一覧の複数選択とFilmstrip切替

最近の写真一覧では、選択したAsset IDを配列で保持する。Setではなく配列にしたのは、最初に選んだ写真を暗室のactiveAssetにし、選択順をそのままFilmstripへ反映するためである。RAW / RAW以外フィルターは表示対象だけを変え、一覧から一時的に隠れたAssetの選択状態は解除しない。

通常状態でカード本体を押すと、従来どおりその1枚だけを暗室へ渡す。チェックから最初の1枚を選ぶと選択モードになり、以後はカード本体でも選択と解除を切り替える。Desktopでは通常時のチェックをホバーまたはキーボードフォーカス時に表示し、hoverのないモバイルではチェックを常時表示して単写真遷移と複数選択開始を分ける。

「暗室へ」では、選択順に解決した `selectedAssets` と先頭Assetの `activeAssetId` をReact Routerのnavigation stateで渡す。Filmstripで別の写真を押したときは `activeAssetId` とURLだけを切り替え、`selectedAssets` は維持する。再読み込み時にnavigation stateが失われた場合は、URLのactiveAsset 1枚をImmichから再取得する既存挙動へ戻る。
