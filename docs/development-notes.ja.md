# GenzoRoom 開発ノート

Homeの現行仕様は4タブ（Recent / Albums / Calendar / Favorites）で、Recentは50〜500件を50件刻みで選択でき、初期値は100件。以下の過去フェーズに記した件数や「未実装」は当時の仕様を示す。現在仕様はこの冒頭節、README、architecture.mdを参照する。

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

unmatchedが0件のときのSTACK候補外sectionは`min-height: 200px`とし、Stack memberのPurge用drop面積を広げた。候補外assetがある場合は既存gridの自然な高さを使い、drop highlightはsection全体に表示する。

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

既存互換性として、JIS配列で`key=']'`となるphysical Backslashの優先判定、NumLock状態によらないNumpadのphysical `code`判定、AltGraph等のmodifier guardを維持した。Filmstripのhover／focus中の単独Arrow移動は廃止し、`Ctrl+Shift+←/→`による前後移動へ変更した。暗室では`F`がViewer集中表示、`Shift+Z`がFitと直前zoom/panの切替、`H`が既存の退出保存経路を通るHome復帰となる。Homeの`D`は選択中なら現在選択で暗室を開き、未選択なら直前の暗室へ復帰する。

Home未選択時の`D`復帰情報はSPA session内のmodule memoryだけに保持し、Storage APIへ書かない。選択写真の順序とactive photoを保ち、Homeから再入場するときの`homeReturn`はその時点のHome表示状態で更新する。Recipe、History、Viewer transform等は保持しない。

`showKeyboardShortcuts`はdefault ONのbrowser preferenceで、ON/OFF radio UIから変更する。Tooltip/Menuの説明表示だけを切り替え、shortcut実行は止めない。Primary／Alternate modifierを`shortcutModifiers.ts`へ共通化し、Windows/LinuxではCtrl／Alt、macOSではCommand／Optionとしてmatchingとformatterの両方で解決する。Undo/Redo、Copy/Paste、選択Copy/Paste、Filmstrip、Settings歯車のmodified clickは論理modifierを利用し、Ctrl+Metaのような反対側modifier同時押しは一致させない。AltGraph除外は維持し、物理modifierが必要なbindingだけ明示指定する。modifier表示を実bindingと揃え、Before長押しとFit／前回表示切替は各ボタン操作と完全同義でないためTooltipに意味を明記した。Primary-modifier clickはclick handler内で同期的にDeveloper tabを開く。将来の実装規則のcanonical sourceはAGENTS.mdとする。

modifier表示を揃えるため、macOSのShift表記を`Shift`から`⇧`へ変更した。ShiftのmatchingはOS共通の`shiftKey`のままで、Windows/Linuxの表示は`Shift`を維持する。formatter testでUndo/Redo、Filmstrip、Shift単独commandの両platform表記を確認する。

検証では関連shortcut/UIのVitest 5ファイル・97件、Frontend全体Vitest 74ファイル・1465件成功（2件skip）、TypeScript check、Frontend build、`git diff --check`が成功した。buildでは500 kBを超えるchunk warningが出たが、modifier変更とは無関係な既知のwarningとして扱った。実機ブラウザや物理キーボードでの確認は行っていない。

### focused code auditと修正

shortcut、表示設定、Home↔Anshitsu復帰、各window listenerをfocused auditした結果はHigh 0／Medium 1／Low 0だった。唯一のMediumは、写真切替の保存失敗alertdialog中にUndo／Redoが背面のRecipe／Historyを変更できる問題だった。Anshitsuのworkspace共通keyboard block状態を`useAssetEdits`へ渡し、`failedSwitch`と`exitFailure`を含むblock中はUndo／Redo listenerを停止するよう修正した。Stayでdialogを閉じると通常のUndo／Redoへ戻る。

回帰テストは切替保存失敗中のCtrl/Cmd+Z、Ctrl/Cmd+Shift+Z、Ctrl/Cmd+Y、Stay後のUndo／Redo復帰、退出保存失敗中のUndo遮断を確認した。修正後のfocused auditでは報告対象のHigh／Medium／Low問題は残らなかった。現行作業ツリーでの関連Vitestは2ファイル・130件成功、TypeScript／Frontend buildと`git diff --check`も成功した。実機ブラウザ確認は行っていない。

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
