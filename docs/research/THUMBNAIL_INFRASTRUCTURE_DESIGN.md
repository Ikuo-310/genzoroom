# サムネイル基盤再設計

2026-11-19（Asia/Tokyo）。初回監査対象コードは `bad7e48eafb356cfecf07994345765d1f5910bb1`。その後のP1実機検証でWindows版・Docker版のSTACK管理およびGalleryにおけるサムネイル欠落をImmich本体でも同一写真で再現した。Immichのサムネイル生成ジョブで「欠落」を実行し、234件のジョブ完了後に全サムネイルが表示されたことから、今回の直接原因をImmich側のサムネイル欠損と特定した。欠損が発生した理由は未調査である。以下では監査で確認した実装、合意済み表示仕様、これから選定する設計、計測で決める事項を区別する。

## 1. 目的と対象

Gallery、STACK管理、Export管理、暗室フィルムストリップ、アルバム、カレンダー、診断画面で使うサムネイルの取得、表示、再利用、無効化を一貫して扱う。通常サムネイル、保存済みRecipeに基づく補正済みサムネイル、Immersive Previewの代理画像を整理し、既存の生成スケジューラとディスクキャッシュを中心に表示整合性を改善する。

既存の補正済み画像生成、Asset単位の保存領域、原子的なファイル公開、デバウンス予約、保存と公開の順序制御を土台として使う。独自のFrontend取得キュー、仮想スクロール、新規ディスクキャッシュは前提にしない。通常／補正済み表示を共通の表示部品・URL解決・状態通知で扱う案を基本にする。

## 2. 証拠と確度

| 区分 | 内容 |
|---|---|
| 確認済み事実 | Gallery、STACK、Exportの写真カードは共通の `thumbnailUrl()` または `PhotoCard` を使う。写真一覧は対象カードをDOMに展開し、一覧の大半は `loading="lazy"` を指定する。STACK候補も全メンバーを展開し、上段・下段に独立スクロール領域がある。暗室フィルムストリップは全画像を展開し、`loading` 指定がない。 |
| 確認済み事実 | 通常サムネイルは `/assets/{id}/thumbnail` からImmichのサムネイルを取得する。補正済み表示は `/assets/{id}/rendered-thumbnail`。取得GET自身は生成を開始せず、生成依頼POSTと保存通知が既存スケジューラを動かす。 |
| 確認済み事実 | 補正済み画像は最大辺1024pxのJPEGで、Asset ID単位のファイルとして最大1 GiBのBackendディスクキャッシュに保存される。古い生成時刻から容量整理し、読取りでは時刻を延長しない。 |
| 確認済み事実 | 保存Recipeの変更は60秒デバウンスで生成予約され、暗室の写真移動・終了などは保存後に即時予約を送る。生成ワーカーは1つで、保存・Resetと公開の順序をロックで保護する。完了をFrontendに通知する仕組みはない。 |
| 確認済み事実 | 初回監査時、Windows LocalHostは画像を含む全レスポンスのCache-Controlを `no-store` に上書きしていた。P3で成功した通常画像／Previewに限りBackendの `private, no-cache` とETagを通す。Docker nginxはBackendへproxyし、画像用proxy cacheもCache-Control上書きも行わない。 |
| 実機確認 | 387枚・193件のSTACK候補を扱うケースで画像欠落がWindows版・Docker版のGalleryとSTACK管理で発生し、Immich本体でも同一写真で再現した。Immichの欠落サムネイル生成ジョブ234件の完了後に全画像が表示された。今回の直接原因はImmich側のサムネイル欠損。 |
| 未確定 | Immich側でサムネイル欠損が発生した理由。P1のFrontend／Backend診断機構は維持し、GenzoRoom側で別の欠落が発生した場合の障害境界を引き続き追跡する。 |
| 実測で判断 | DOM・画像デコードメモリ、ブラウザ同時接続・待ち時間、Backend event loop・ワーカープール・HTTP接続数、Immich応答時間、画面間キャッシュ再利用率。1,000枚以上の負荷試験で測る。 |

添付ログではBackendからImmichへの写真画像取得20件はHTTP 200で、同じAssetの詳細取得も観測された。初期ログだけでは欠落画像に対応付けられず原因は未確定だった。後続のWindows版・Docker版実機確認では、同一写真の欠落をImmich本体でも再現し、Immichの「欠落」サムネイル生成ジョブ234件の完了後に表示を確認した。**この事象の直接原因はImmich側のサムネイル欠損である。欠損理由は未調査。P1診断機構は、将来のGenzoRoom／通信／デコード障害の切り分けに備えて維持する。**

### P1完了記録

共通Frontendに画像source割当、要素解放、load失敗、natural寸法を記録する診断を追加し、通常・補正済み・PreviewのBackend画像ルートに受信、cache hit、fallback、応答／例外の診断を追加した。debugレベル時のみFrontend UUIDとBackendログを相関する。Windows版・Docker版の今回の欠落はImmich側と特定された。P1は完了。P2～P7の計画順序は維持する。

### P2実装記録

Backend lifespanが通常のImmich thumbnail／preview／asset detail GETおよびJPEG補正サムネイル生成で共有する `httpx.AsyncClient` を所有し、終了時に閉じる。Immich API keyは従来通りリクエストごとのヘッダーとして渡し、接続先のHTTPX poolはoriginごとに分かれる。原本streamingとExport書込みは既存の独立した接続・cleanup境界を維持する。Recipe資格判定と生成ワーカーから未使用のAsset detail取得を除去し、cache miss時は後続のImmich画像要求でAssetを確認する。生成予約と既存補正画像のcache hitでは、削除済みAssetの誤処理・誤配信を防ぐdetail確認を維持する。回帰テストでは呼出し側所有Clientが複数要求の間に開いたまま維持されることと、重複した詳細取得を行わないことを確認した。TCP接続再利用の実環境計測、接続待ち時間の比較、profile切替時の運用確認はP7の実機・負荷検証に残す。

### P3実装記録

| 画像種別 | 変更前 | 変更後 |
|---|---|---|
| 通常サムネイル | Backend `private, max-age=300`。Windows LocalHostは `no-store` に上書き。 | 両環境 `private, no-cache`＋強いETag。毎回Immichで現行Assetを確認し、内容一致時は304。 |
| 補正済みサムネイル | `private, no-store`。 | `private, no-store`を維持。P5公開版前に保存キャッシュを有効化しない。 |
| 補正済みサムネイルのFallback | `private, no-store`。 | `private, no-store`を維持。 |
| 通常Preview | Backend `private, max-age=300`。Windows LocalHostは `no-store` に上書き。 | 両環境 `private, no-cache`＋強いETag。 |
| Immersive Preview | `private, no-store`。 | `private, no-store`を維持。補正済み／Immich fallbackの混在URLを保存しない。 |
| 原本画像 | `private, no-store`。 | `private, no-store`を維持。streaming・Export経路も維持。 |
| 画像エラー | Windowsは `no-store`。Docker Backendでは全経路の明示保証なし。 | 両環境 `private, no-store`。 |

300秒からの変更理由は、fresh期間内に接続先・API key・ユーザーが切り替わった場合やAsset削除・権限変更後、ブラウザがBackendへアクセス確認せず古い画像を返すため。`no-cache`は画像本体をブラウザのprivate cacheに保持しながら再検証を必須にする。Backendは現在のImmich応答を先に得てからETagを比較するため、同じ内容なら304で画像本文を返さず、変化時は新本文、上流エラー時は現在のエラーとなる。ETagはmedia typeと画像内容から作り、秘密を含めない。

Windows Hostは通常サムネイル／Previewの成功200／304かつ画像Content-Type、Backendの許可済みCache-Control、ETagが揃う場合だけ両ヘッダーを通す。HTML、設定、認証、状態API、原本、補正済み、エラーは `no-store` を維持する。Dockerのfrontend／release nginx双方にproxy cacheやheader rewriteはなく、Backendヘッダーを中継する。P3ではP2のHTTPX shared clientへCookie-free transportを追加し、Cookieを送信せず、`Set-Cookie`を受け入れない。

P3の自動検証はBackendの画像Cache-Control／ETag／304／エラー応答、Windows Hostの画像ヘッダー反映・非画像およびエラーのno-store、HTTPX shared clientのCookie非保持・再送なし、Docker nginxのCache-Control中継構成を対象とする。Recipe保存・Reset後も補正画像が `no-store` のままfallback／最新cache内容を返すことを関連API回帰テストで確認する。Windows WebView2とDocker実ブラウザでの再検証・profile変更・ユーザー切替は未実施であり、P7の手動確認に残す。P4以降には着手していない。

### P3追加監査記録：F1 未捕捉例外とF2 streaming

**F1**：通常のreturned 4xx／5xxはResponseを通るためCache-Control middlewareで保護できるが、未捕捉例外はFastAPIの外側の `ServerErrorMiddleware` が500を生成するため、内側の `call_next()` middlewareではレスポンスへ到達できなかった。共通Backendに未捕捉例外handlerを追加し、asset image pathでは既定の汎用本文 `Internal Server Error` に `private, no-store` を付ける。非画像の500本文・状態・ヘッダーは従来の既定動作を維持する。handlerは例外を再throwしないが、Starletteの `ServerErrorMiddleware` が送信後に元例外を再throwするため、Uvicorn側のエラー記録と失敗伝播は維持される。例外文や認証情報は応答へ含めない。

**F2**：実行環境のStarlette 1.7.0で `BaseHTTPMiddleware.call_next()` の実装を確認した。本文を全量メモリへ読み切るのではなくmemory channel経由で順次yieldするが、task groupとdisconnect監視で全HTTP responseを包んでいた。画像エラー制御をPure ASGI middlewareへ置換し、asset image path以外は元の `receive`／`send` をそのまま下位appへ渡す。画像pathでもresponse-startだけを検査し、body chunkや送受信例外には介入しない。

原本の所有境界は変更していない。`ImmichOriginal.chunks()` のfinallyが上流ResponseとHTTPX clientをcloseし、正常完了時の `StreamingResponse` BackgroundTaskも従来どおり実行される。追加ASGI回帰テストで先頭chunkが後続chunk生成完了前に送出されること、クライアントdisconnect後にstream generatorがcloseされることを確認した。上流ReadTimeout時の例外伝播とResponse／client解放は既存の `test_midstream_timeout_releases_connections` で再確認する。開発用roundtrip streamingはasset image middleware対象外であり、既存回帰テストで本文の連結順とCache-Controlを維持することを確認する。

## 3. 現行の取得・表示経路

| 画面・機能 | 表示画像・取得先 | 現行挙動と留意点 |
|---|---|---|
| Galleryの最近・お気に入り・アルバム内・カレンダー日別 | 共通PhotoCard。既定は補正済みGET。 | 全カードDOM展開。画像はlazy。画面更新時の `view` は補正済みURL用で、生成公開版ではない。 |
| STACK管理 | 補正済みOFFはImmich thumbnail、ONは補正済みGET。 | 全候補メンバーを展開。画像はlazy。候補分類の再描画でカードの親・keyが変わればimgが差し替わる可能性がある。 |
| Export管理 | 補正済みGET。 | 全Queue行・Stackメンバーを展開しlazy。カード情報の詳細取得は画像GETとは別。 |
| 暗室フィルムストリップ | 補正済みGET。 | 全選択画像のimgが即時取得対象。アクティブ位置へスクロールするが、画像取得優先度の制御はない。Recipe変更revisionは表示画像URLへ結び付いていない。 |
| アルバム一覧・カレンダー月 | Immich thumbnail。 | 代表画像のみ。画像はlazy。カレンダーは画像が有効な日付に限定される。 |
| Immersive Preview | 補正表示ONでは補正済みキャッシュ、未生成・欠損時はImmich Preview。OFFではImmich Preview。STACKのOFFはImmich thumbnail。 | 一度に現在の1画像を表示。GETは生成予約を行わない。通常カードと画像サイズ・用途が異なるので、共通化はURL選択と更新通知までにする。 |
| 暗室Viewer・ナビゲーター・ルーペ | ライブ編集Preview、Before画像、RAW Crop/Region surface等。 | 編集中の表示画像。保存済みサムネイルとは所有・更新タイミングが異なるため、一覧サムネイルの共通部品へ統合しない。 |
| Export処理 | Immich原本をBackendが取得しLightCraft等の出力処理へ渡す。 | 一覧表示用サムネイルではない。原本保護とExportのデータフローを維持する。 |

主な実装位置は [thumbnailUrl.ts](../../frontend/src/thumbnailUrl.ts)、[PhotoCard.tsx](../../frontend/src/PhotoCard.tsx)、[StackManagementPage.tsx](../../frontend/src/StackManagementPage.tsx)、[ExportManagement.tsx](../../frontend/src/ExportManagement.tsx)、[Filmstrip.tsx](../../frontend/src/Filmstrip.tsx)、[AlbumCard.tsx](../../frontend/src/AlbumCard.tsx)、[HomeCalendar.tsx](../../frontend/src/HomeCalendar.tsx)、[ImmersivePreview.tsx](../../frontend/src/ImmersivePreview.tsx) である。

## 4. キャッシュ・接続・ライフサイクルの現状評価

### Backend生成と永続キャッシュ

JPEG生成は保存Recipeを読み、Immich Previewを取得し、縮小後にGenzoRoomのRecipeを適用する。WindowsのRAW生成は原本の一時コピーと独立LightCraftセッションからJPEGを作る。どちらも現行 `ThumbnailCache.store(asset_id, content)` の契約へ保存する。LightCraftの現像解釈やPreviewアルゴリズムはGenzoRoomで再実装しない。

`ThumbnailScheduler` はAsset単位の予約・重複抑止、単一ワーカー、生成中の無効化、キャッシュ公開、終了時の予約破棄を持つ。Recipe保存、Reset、RAWのHistory操作と生成公開は `mutation_lock` で順序づける。この生成・公開の境界は維持する。

キャッシュはプロセス毎・ストレージプロファイル毎に存在する。Dockerでは `/genzoroom/cache/thumbnails`、Windowsでは選択プロファイルのLocalAppData領域となる。TTLやFrontendへの公開通知はない。1GiBのディスク上限はブラウザのデコード済み画像メモリや転送中バッファを制限しない。

### Immich通信

P2後、通常画像・Preview・詳細取得・JPEG補正サムネイル生成はBackend lifespan所有の `httpx.AsyncClient` を共有する。P3ではそのClientのtransportでImmich Cookie送受信を止めた。原本streamingとExport書込みは引き続き独立している。Recipe資格判定と生成ワーカーから不要な詳細取得は除去済み。補正GET cache hitと生成予約ではAsset存在・権限を確認し、通常画像のETag再検証では現在のImmich画像を取得してから304可否を決める。

P2ではlifespan所有の共通接続再利用を実装し、通常画像・Preview・詳細取得の呼出しで共有する。P3でブラウザ再検証時にImmichの現行Asset応答を確認し、Asset削除・権限変更や接続切替後に旧画像を無検証で返さない条件を定義した。原本streaming、Export書込みは独立したままとし、各Immich要求の接続先とAPI keyはリクエスト単位で指定する。接続上限はHTTPX既定値を維持し、大量画像の同時要求・待ち時間をP7で実測して見直す。

### ブラウザキャッシュと認証境界

P3後の通常 `/thumbnail` と `/preview` は両環境で `private, no-cache` と強いETagを返す。ブラウザはprivate cacheに画像本体を保存できるが、次の表示時にBackendへ再検証し、Backendは現在のImmich接続先・資格情報で画像を取得して比較する。同一内容なら304で画像本文の再転送を避け、変更なら新しい本文とETagを返す。Asset削除・権限変更・接続先やユーザーの切替後にfreshなブラウザ応答だけで旧画像を返さないため、既存の300秒fresh期間は採用しない。

補正済みGET、そのfallback、Immersive Preview、原本は `private, no-store`。P5のAsset公開版管理がなく同じURLの画像内容が変わるため、補正結果をブラウザへ保存させない。Windows LocalHostは通常画像／Previewの成功200／304だけBackendの許可済み `private, no-cache` を通し、HTML、設定、認証、状態API、原本、補正済み、エラーは `no-store` を維持する。Docker nginxにproxy cacheやCache-Control上書きはなく、Backendヘッダーをそのまま通す。ETagはmedia typeと画像内容のSHA-256であり、秘密・Assetの認証情報を含まない。

共有HTTPX clientはImmichのCookieを送信せず、`Set-Cookie`も取り込まない。Immich API keyは既存通りBackendの各要求ヘッダーにのみ置かれ、URL・ETag・診断ログへ含めない。Frontendに画像バイトキャッシュや独自共有機構は追加しない。再検証のたびにImmich画像GETは発生するため、P3が削減するのはBackendからブラウザへの同一画像本文の再転送である。接続再利用と実トラフィックの影響はP7で測る。

## 5. 合意済み補正サムネイル表示仕様

表示状態はAsset単位の最新公開結果を参照する。補正済み表示OFFは従来通り通常サムネイルを使い、補正生成状態でURL・画像を置き換えない。

| 状態 | 表示画像 |
|---|---|
| 未現像 | Immichサムネイル |
| 初回生成待ち | Immichサムネイル |
| 再生成待ち | 前回の補正済みサムネイル |
| 生成完了 | 最新の補正済みサムネイル |
| Reset保存完了 | Immichサムネイル |
| 生成失敗 | 最後に正常生成された画像。存在しなければImmichサムネイル |
| キャッシュ消失 | Immichサムネイル |

生成完了はAsset単位でFrontendへ伝わり、該当Assetの表示だけを自動更新する。タブ再入場や手動更新を完了通知の代わりに要求しない。画面遷移中に通知が届いても、次の表示は最新公開版を解決する。URLの公開版keyや状態APIの形、通知にSSE・WebSocket・ポーリングのどれを使うかは未確定であり、P1計測と既存通信方式を踏まえP5で選ぶ。

生成状態と公開済み成果物は区別する。新Recipe保存が完了したことを、補正済み画像の生成完了として扱わない。生成失敗時に最後の成功画像を残す仕様とキャッシュ消失時のImmichフォールバックは合意済みだが、現在の単一ファイルキャッシュでは生成失敗前の画像を残せる一方、容量追い出し後の旧版を復元できない。Resetは保存成功後に補正画像を無効化する。非デフォルト再保存では旧版を保持して新生成を待つ。

## 6. 工程計画

工程の順序P1～P7は合意済み。P1はWindows固有経路の切り分けから始めず、Docker・Windowsに共通するFrontend img生成からBackendルートとImmich応答、ブラウザデコードまでを優先して計測する。P3ではWindows固有のHTTPキャッシュも引き続き改善する。

### P1：診断ログ追加・サムネイル欠落原因の特定

**目的**：Windows版・Docker版で再現する欠落の停止境界をAsset単位で特定する。

**実装範囲**：Frontend共通表示経路に、表示モード、安定した画面／セッション識別子、img load/error、自然寸法、Asset ID、更新世代を記録する診断を追加する。Backend共通の画像ルートで、要求到達、保存状態判定、キャッシュhit/miss、フォールバック種別、Immich結果、応答時間と結果を既存構造化ロガーで観測する。必要ならCDP Networkの要求発行・待機・完了・失敗・キャッシュ情報を採取する手順を決める。

**依存関係**：なし。現行ログのプライバシー規則とFrontend／Backendロガーを再利用する。

**維持する既存仕様**：通常・補正済みURL契約、GETは生成しない、Recipe／History本文や認証情報をログへ出さない、ログ失敗で表示動作を変えない。

**受入条件**：WindowsとDockerの双方で387枚相当を再現し、欠落AssetについてDOM可視化、ブラウザ要求、Backend到達、Immich取得、Frontend画像decodeの最終観測点を説明できる。少なくとも一つの失敗・中断ケースでも診断が相関する。1,000枚表示でログ量が有界であり、通常ログに画像本文や資格情報がない。

### P2：Backend HTTP接続再利用・不要なAPI呼び出し削減

**目的**：サムネイル表示によるImmich往復時間、接続作成、不要な詳細API呼び出しを減らす。

**実装範囲**：Backend lifespanが所有するHTTPクライアント／接続プールを導入または既存クライアント構成へ統合する。短命の画像レスポンスを確実にcloseし、接続先・認証profileの分離を維持する。補正済みGETと生成における詳細取得のうち、保存状態判定やAsset資格に必要な部分を特定し、重複問い合わせを除く。

**依存関係**：P1で通信境界・接続待ちを記録できること。

**維持する既存仕様**：Immich資格情報はBackendだけに置く。timeout、HTTP status、Content-Type検証、原本streamingのcloseとキャンセル後cleanupを保つ。補正画像生成とExportの処理責任は分離する。

**受入条件**：同一接続先の連続画像取得でHTTP接続再利用が確認できる。キャッシュヒット時の不要詳細要求が削減される。クライアントshutdown、要求失敗、キャンセル後も応答streamが残らず、接続先切替後に別プールの資格が混ざらない。実測で同時要求と待ち時間の改善を示す。

### P3：HTTPキャッシュ制御の適正化

**目的**：認証・接続先境界を守りながら、画面間で同一サムネイルをブラウザが安全に再利用できるようにする。

**実装範囲**：通常thumbnail／Previewに内容ETagとprivate revalidationを使う。補正済み／Immersive／originalはP5までno-storeを維持する。Backend画像エラーもno-storeとする。Windows LocalHostは許可済み通常画像ヘッダーだけを通し、Docker nginxはBackendのCache-Controlを変更しない。共有HTTPX clientはImmich Cookieを保存・再送しない。

**依存関係**：P1で配信経路を確認し、P2で接続・資格境界を整理する。実装完了。実機ブラウザのCache revalidationはP7で検証する。

**維持する既存仕様**：共有proxyへユーザー画像を漏らさない。通常画像はprivate cacheに保持し、Asset状態・権限は再検証する。P5の公開版管理前に補正済み画像をcacheしない。Windows認証・Origin制御を弱めない。

**受入条件**：同一画像の再検証で304となり、異なる画像は新本文となる。エラー・削除Assetにキャッシュ本文を返さない。Windowsでは通常画像の許可済みヘッダーだけが反映され、他レスポンスはno-store。Docker nginxがBackend headerを変更せず共有proxy cacheを行わない。HTTPXにCookieが保持・再送されない。補正済み画像はno-storeを維持する。実機profile変更とブラウザ再検証はP7で確認する。

### P4：Frontendサムネイル表示コンポーネント共通化

**目的**：画像URL選択、遅延読み込み、load/error、失敗表示、表示世代の採用規則を一箇所で扱う。

**実装範囲**：Gallery、STACK、Export、Filmstrip等の一覧用表示を共通部品または共通hookへ移行する。通常表示／補正済み表示の選択、アクティブ・可視画像の優先、失敗状態の回復操作、Asset単位の公開版更新を統合できる責任境界を設計する。Immersiveは同じURL解決・公開版通知を使えるが、大きい画像向けの表示コンポーネントは分離を許容する。

**依存関係**：P1で欠落境界を特定し、P3でURLとcache制御を定義する。P5の公開版通知と接続するためAPIを合意する。

**維持する既存仕様**：Alt、Format badge、選択・ドラッグ操作、各画面のアスペクト比、STACKの補正OFF、Galleryの選択とフィルタリングを保つ。ネイティブlazy loadingを基本とし、P1が必要性を示さない限り独自取得キューや仮想スクロールを導入しない。

**受入条件**：対象画面が共通表示状態機械に従い、画像成功・失敗・表示変更を診断できる。再描画・画面遷移をまたぐ同一Asset画像が安全に再利用され、画面固有の機能テストで既存操作を保つ。

### P5：補正済みサムネイルの公開版管理・自動更新

**目的**：画像の最新性を画面別revisionでなく、Asset単位の生成・公開結果で管理する。

**実装範囲**：スケジューラの生成予約・成功・失敗・Reset・キャッシュ消失をFrontendへ反映できる公開版識別子と状態を設ける。保存Recipe revisionと最後に正常生成した公開成果を区別する。生成完了時に同Assetを表示する全コンポーネントを無効化し、自動再取得させる。実行中再保存時は古い生成物を既存のpublication fenceで破棄し、古い版が最新として公開されない。

**依存関係**：P2で不要なAsset詳細問い合わせを整理し、P3で版付きURLとcache policyを定め、P4の共通表示部品へ接続する。

**維持する既存仕様**：単一ワーカー、60秒デバウンス、暗室からの即時依頼、GET非生成、原子的なファイル置換、mutation lock、Reset後の旧出力無効化、最後の正常生成画像を残す表示仕様。

**受入条件**：表「合意済み補正サムネイル表示仕様」の全状態を確認する。生成完了で同Assetだけが自動更新し、同じ画像を出す他画面も画面遷移なしで更新される。Recipe変更・Reset・生成中再保存・失敗・容量追い出し・削除後も古い成果物を最新として公開しない。

### P6：暗室フィルムストリップの動的更新

**目的**：多数の選択画像が並ぶストリップで初期取得負荷を抑え、現在編集中Assetの保存済み画像を自動反映する。

**実装範囲**：フィルムストリップ画像へ遅延読み込みを適用し、アクティブ画像の読み込みを優先する。編集中操作ごとにサムネイル生成や表示更新は行わない。写真移動時の現行保存・即時生成依頼と、P5のAsset公開版通知を使い、完了後は該当Assetだけを更新する。

**依存関係**：P4の共通表示部品とP5のAsset公開版管理。

**維持する既存仕様**：生成完了を待たずに次の写真へ移動できる。Recipe保存・写真移動時の即時生成依頼、History/Undo/Redo、Filmstripの横スクロールとアクティブ項目可視化を維持する。ストリップ専用の更新機構を設けない。

**受入条件**：初期表示でオフスクリーン画像を一斉取得しない。アクティブ写真は優先して表示される。写真移動は生成完了を待たず、生成完了後は該当Asset画像だけが自動更新する。編集中の逐次生成依頼が増えない。

### P7：大量画像での総合検証・完了監査・文書追随

**目的**：共通基盤を387枚と1,000枚以上で検証し、欠落・表示整合性・資源使用を受入基準に照らして完了判定する。

**実装範囲**：Windows版とDocker版でGallery、STACK、Export、Filmstrip、Album、Calendarを対象に低速／高速スクロール、タブ遷移、再入場、失敗からの回復、通常／補正表示を検証する。Frontend DOM数、ブラウザ画像要求とdecode、メモリ、Backend処理時間・同時数、Immich要求数、cache hit率を記録する。確定したユーザー向け仕様があればREADME両言語を同期し、技術設計は本書または既存architectureに追随する。

**依存関係**：P1～P6の実装と、それぞれの受入条件が成立していること。

**維持する既存仕様**：原本保護、Immich資格情報の秘匿、Recipe・Historyの整合性、Export queue動作、開発エンジンごとの責務境界を維持する。

**受入条件**：387枚および1,000枚以上で可視カードの画像欠落が再現せず、発生したエラーも利用者が復旧でき、ログで停止境界を説明できる。補正画像状態表を全遷移で満たす。画像取得量とメモリ・待ち時間を記録し、仮想スクロール等の追加が必要かは実測結果から判断する。Windows実機、Docker実機確認はそれぞれの担当者が行い、未実施を完了扱いしない。

## 7. 未確定事項と判断ゲート

| 項目 | 現時点の扱い | 判断する工程 |
|---|---|---|
| 欠落の正確な境界 | P1で実機確認済み。Windows・Docker双方の同一写真がImmich本体でも欠損し、「欠落」生成ジョブ234件完了後に表示。直接原因はImmich側サムネイル欠損。欠損理由は未調査。 | P1完了 |
| ブラウザlazy loadingを置き換える必要性 | 独立スクロール領域や全DOM展開は既知だが、根本原因とは未証明。 | P1の原因とP7の負荷測定後 |
| HTTP clientの所有範囲・接続上限 | P2で通常画像・Preview・詳細GET・JPEG補正サムネイル生成にlifespan共有clientを導入。P3でImmich Cookie非送信・Set-Cookie非保持を追加。原本streamingとExport書込みは分離。接続上限はHTTPX既定値で、実負荷計測後に判断する。 | P7で評価 |
| 詳細API問い合わせの省略可否 | Recipe判定／生成ワーカーとcache miss時の重複detail取得をP2で除去。生成予約とcache hitのAsset存在確認は維持。実機Immich通信量の比較は未実施。 | P2完了／P7計測 |
| ブラウザ画像キャッシュのprofile分離 | P3でfresh cacheを避け、各表示で現行Immich接続先／資格情報による再検証を行う。ETagは画像内容のみから導出する。 | P3完了／P7実機確認 |
| Asset公開版の伝達方式 | 版付きURL＋現在状態の読取りを基本にし、pushか他の既存通知方式かは未決定。 | P5 |
| 旧成功画像の保持と容量整理 | 最新成功版を失敗時まで保持する。別世代を併存する場合の容量・削除ルールは未確定。新規キャッシュ機構を先行導入しない。 | P5の必要性評価、P7実測 |
| 大量表示でDOM仮想化が必要か | 1,000枚を含む実測値が判断材料。合意として導入を前提にしない。 | P7 |

## 8. 維持・共通化・置換の方針

| 分類 | 対象 |
|---|---|
| 維持 | 既存JPEG/RAW補正生成、LightCraftへのRAW処理委譲、Asset単位ディスクキャッシュ、単一生成ワーカー、デバウンス／即時生成依頼、mutation lockによる公開順序制御、Reset無効化、原子的ファイル置換、ImmersiveのPreview fallback。 |
| 共通化 | 一覧サムネイルのURL解決、lazy/eager優先度、load/errorと回復表示、Asset公開版の購読と更新、共通ログ項目。通常画像と補正画像を同じUI状態処理で扱う。 |
| 見直し・置換 | P2で要求毎のImmich画像Clientと補正済みGET／生成の不要なAsset詳細取得を置換済み。P3でWindowsの一律no-storeを許可済み通常画像／Previewの再検証cacheへ置換済み。残る対象は画面別 `view` revision、Filmstripの全画像即時要求。 |
| 導入を保留 | 独自Frontend取得キュー、仮想スクロール、新規ディスクキャッシュ。P1の原因特定とP7の計測が必要性を示した場合だけ、別の判断根拠を記録する。 |

P1・P2・P3の実装記録と自動テスト結果を追記済み。P3のWindows LocalHostとDocker nginx構成はコード／設定テストで確認したが、Windows WebView2とDocker実ブラウザでのCache revalidation、プロファイル切替、負荷計測は未実施。これらはP7の手動検証に残す。

## 9. P4実装記録

### 確定仕様・変更内容

P4の対象画面は既にP1の`ThumbnailImage`を使っていたため、各画面に別の画像部品を増やさず、共通部品に状態管理・失敗回復・URL解決を加えた。`ThumbnailImage.tsx`が画像要素の状態・診断・再試行を所有し、`thumbnailUrl.ts`の`thumbnailSourceUrl(assetId, rendition, revision?)`がAsset IDから通常サムネイル、補正済みサムネイル、Preview、Immersive PreviewのURLを解決する。既存`thumbnailUrl()`は補正済みURL用の互換ラッパーとして同じ解決処理を使う。STACKの補正表示OFFとCalendar APIの代表URLのように既存URLをそのまま使う経路は明示的な`src`指定を保つ。

| 画面／経路 | P4の利用方法 |
|---|---|
| Gallery Recent／Albums内一覧／Calendar内一覧／Favorites | `PhotoCard`を通じて共通部品を利用。補正済み表示と既存`thumbnailRefreshKey`を`rendered-thumbnail`とrevisionとして解決し、lazyを維持。 |
| STACK管理 | 共通部品を継続利用。補正表示ONはAsset ID＋既存revisionから補正済みURLを解決、OFFはAssetのImmich URLを維持。Format badge、COVER、選択、STACKドラッグ制御を保持。 |
| Export管理 | 共通部品から補正済みURLを解決し、既存Export画面revisionとlazyを維持。表示GETは生成を起動しない。 |
| 暗室フィルムストリップ | 共通部品からAsset IDで補正済みURLを解決。現在のアクティブ画像に`fetchPriority=high`を付ける。P6前の現行読込範囲は変えず、lazy導入・可視範囲最適化は保留。 |
| アルバム代表画像 | Asset IDから通常サムネイルURLを解決し、lazyを維持。 |
| カレンダー代表画像 | Backendが返す既存URLとAsset IDを使用し、lazyを維持。URL自体を再構成せず、Backend契約を保つ。 |
| Immersive Preview | 共通部品のURL・状態・診断を使用し、`preview`／`immersive-preview`の切替をAsset IDから解決。大画像表示固有のレイアウトは`ImmersivePreview`に残し、eager/highで読み込む。 |

### 状態遷移・イベント保護

表示状態はAsset ID・解決URL・任意の公開版識別子・手動再試行番号を単位に`loading`、`loaded`、`failed`へ遷移する。`data-thumbnail-state`で画面テストと開発者診断から状態を識別できる。ソース／公開版が変わると新しい画像要素に切り替え、古い要素のload/errorイベントは現在の要求keyとの照合で捨てる。アンマウント時は未完了要求をP1の`image.elementReleased`で記録する。ブラウザの`img`要素を外した後に独自Abortやキューを追加せず、世代照合で遅延イベントの状態汚染を防ぐ。

読み込み失敗時は画像枠内に控えめな再取得アイコンを表示する。画像要素をクリック、またはフォーカスしてEnter／Spaceを押すとその要素だけを再マウントし、同じURLを再要求する。操作イベントは親へ伝播しないため、Galleryの選択、STACK構成／選択、Export操作を変えない。他Assetの要素key・URLは変わらない。自動Retryはなく、GETから補正サムネイル生成を起動しない。再試行ごとにP1診断IDが新しくなり、URLは診断ログへ記録しない。

### P5接続境界と維持仕様

`ThumbnailImageProps.publicationVersion?: string | number | null`を追加し、将来Asset単位の公開版識別子が変わった際に、対象Assetの画像要素のみを再評価できる。P4では公開版の通知・購読、状態管理、公開版をURLやHTTP cache keyへ適用する処理は実装していない。既存のGallery／STACK／Export `view` revisionは残し、置換はP5まで行わない。補正画像HTTP cache policyもP3契約のまま維持する。

補正サムネイル生成予約、Recipe保存／Reset、保存順序制御、Asset単位ディスクキャッシュ、原子的置換と無効化には変更なし。標準lazy loading、各画面レイアウト・アスペクト比・badge／overlay、選択・複数選択・ドラッグ、Stack補正OFF、Gallery filter、Filmstripアクティブ表示・scroll、Preview fallbackを維持した。

### 検証結果

- 共通表示部品・URL helper、PhotoCard、STACK、Export、Filmstrip、Gallery Albums／Calendar、Gallery Preview、暗室関連のFrontend回帰テスト11ファイル411件が成功。
- Frontend TypeScriptチェックとProduction buildが成功。既存のbundle size warningとReact Routerの`use client` directive warningは出力された。
- Frontend全テストは4329件中4188件成功、2件skip、139件失敗（4ファイル）だった。うち`ExportEngineDiagnostics.test.tsx`の2件はP1由来のThumbnailImage診断ログが従来の「ログが空」というテスト想定と競合したため、Export固有ログのみ空であることを検査するよう意図を維持して更新し、単独テストを含むP4関連11ファイル411件が成功した。残る失敗には`RawPointColorControls.test.tsx`の`raw.setPointColorRangeIndex is not a function`があり、単独実行でも再現した。ほかの失敗もP4対象外のRAW調整ファイルで発生した。RAW調整領域は本変更外であり、Frontend全体の再実行はしていない。
- P1診断ログは共通部品内で維持し、URL・認証情報を記録しない。サーバー側生成APIを追加せず、再試行もGETのみであることを既存URL／画面テストで確認した。
- WebView2／Dockerでの実画像障害時の手動回復、画面間のブラウザHTTP cache hit、1,000枚負荷、メモリ・待ち時間はP7の実機検証に残す。

P4は実装完了。P5の公開版通知・Asset単位更新、P6のFilmstrip読込範囲最適化、P7の大量画像実機検証は未着手。

