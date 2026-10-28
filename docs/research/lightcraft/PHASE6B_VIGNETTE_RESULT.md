# Phase 6B — 周辺光量補正の統合結果

実施日: 2026-10-28。対象: `feature/lightcraft-integration`、開始HEAD `ee3e2aff6a20a7db40e6151092c8e8cb67ad8efd`。

## 実装

RAWの「エフェクト」内は「基本エフェクト / Reset」「周辺光量補正 / Reset」の順。
後者は3モードのネイティブradioと5個の既存AdjustmentSliderで構成する。
日本語のモード名はハイライト・カラー・ペイント、英語はHighlight・Color・Paint。
カテゴリ全体のeyeは従来の`effects`。JPEGのカテゴリやRecipeスキーマは変更しない。

| Native control ID / JSON path | 範囲 | step | Reset |
|---|---:|---:|---:|
| vignette.amount | -100〜100 | 1 | 0 |
| vignette.midpoint | 0〜100 | 1 | 50 |
| vignette.feather | 0〜100 | 1 | 50 |
| vignette.roundness | -100〜100 | 1 | 0 |
| vignette.highlights | 0〜100 | 1 | 0 |

数値は既存`develop.set`経路。表示精度は0桁。styleは数値allowlistに含めず、既存History操作APIの
`{kind:"vignetteStyle",metadata:{style}}`から`develop.merge {settings:{vignette:{style}}}`へ渡す。
enumは`highlightPriority / colorPriority / paintOverlay`のみをBackend/永続History/Frontend readbackで許可する。
モード操作は先にスライダーgestureを確定し、1操作1step。同じモードはNative mutationもstepも増やさない。
Native readbackを設定全体と比較し、style以外が変わった場合は既存rollback/retry経路で拒否する。

`desired.amount ?? confirmed.amount`が0なら中心点・ぼかし・丸み・ハイライトを操作不能にする。
値は保持し、非0で復帰する。モードはamount=0でも有効。ハイライトをモードで無効化しない。
カテゴリOFFでは従来同様、スライダーとモードを無効化する。
Shift+上下の表示順にモード行を含め、Shift+左右でモード内を移動できる。
通常のradio選択は標準キーボード操作を使う。保存ロックによる一時的無効化で、ユーザーが離れていなければフォーカスを復元する。

## ON/OFF・Reset・保存

- 全体ON/OFFは`develop.sectionEnabled {section:"effects"}`。基本3項目・周辺光量・非公開粒子へのNative本来の作用を維持する。
- 基本エフェクトResetは`resetSection effects`のみ。周辺光量に触れない。
- 周辺光量Resetは`resetSection vignette`のみ。上表の数値を戻し、style・disabled_sections・grain/seed・他カテゴリを保持する。独立した1step。
- 個別Resetは`develop.resetControl`。数値gesture、Undo/Redo/Jump、Redo分岐、no-op、保存失敗時の同一saveId再試行、Recipe再読込は既存基盤を使う。
- 設定全体を保存する方式を維持。非公開grain/seedを含むsnapshotを破棄しない。Native再生成後も数値とstyleを復元する。DB形式変更なし。
- History表示では「基本エフェクト リセット」「周辺光量補正 リセット」を区別し、モード変更には選択結果を表示する。

## 応答サイズ

実際のHTTPテスト: 200step・各25項目の全精度差分で **423,635 bytes**。History一覧の512KiB上限は両側とも維持。
別の20stepテストは22,062 bytes。
25個のcontrol spec・全精度値・History receiptを含む操作応答は **4,275 bytes** となり、従来4KiBで502になった。
このため操作応答/設定取得/数値更新のFrontend読取上限を8KiB、Backend History操作応答上限を8KiBへ整合させた。
リクエスト本文の4KiB上限、History一覧上限、永続receipt形式は変更しない。

## Native画質probe

再現: リポジトリルートで`.venv/Scripts/python.exe native/lightcraft/vignette_probe.py --json-out docs/research/lightcraft/PHASE6B_VIGNETTE_RESULTS.json`。
結果は同名JSON、CPU Wholeの比較用一覧は同名PNG。
元のEffects probeの合成RGB、MCP、artifact検証、差分集計とRegion contract検証を再利用する。
正規管理artifactのみ使用し、一時プロセスはfinallyで停止する。Nativeソース・patch・manifestは変更しない。

LightCraft **v0.14.0 / 03c88c166c054c009db2a47187d59991f6232b85**。
binary SHA-256: `b872315ccd11c5c2e945f473d8ca48022127a4cc196b95d16ff3d8fb75004251`。

素材は1024×768で生成した波形・明暗矩形を2048×1536へ拡大してimportしたRGB PNG。実RAWではない。
空間エフェクト3項目・NR・シャープ量は0にして周辺光量の座標依存だけを分離した。
同じsettings・backend指定・virtual full grid・qualityのWholeとRegionを比較する。
1024 gridは全11設定、2048 grid（素材の100%）は正/負補正とハイライト保護設定。
各Draft/Full、中央・四隅・左端・Pan後の異なるorigin、ROI 384×288、context=16。密度の異なる画像間の比較は行わない。

| 結果 | CPU指定 | DX12指定 |
|---|---:|---:|
| Whole/Region比較数 | 196 | 196 |
| 全比較の最大channel差 | 0 LSB | 0 LSB |
| mean / p95 / p99 / >3・>8 LSB割合 | 全て0 | 全て0 |
| Whole実行経路（36回） | CPU 36 | GPU成功36 |
| Region実行経路（196回） | CPU 196 | GPU成功192、CPU fallback 4 |

CPU/DX12 Whole Full 1024比較は11設定とも最大1 LSB、p95/p99=0。
正負補正、midpoint/feather/roundnessの変更が画素へ作用することを確認した。
amount=0の従属値変更は画素不変。負補正＋Highlight＋highlights=100の保護はColor/Paintに対して最大149 LSBの差で確認した。
ColorとPaintはこの負補正条件では同じ画素になる。正補正では3モードが同じになることも確認した。
これは調査済みNativeの処理条件に沿う挙動で、モード独自アルゴリズムは追加しない。
5数値のdevelop.set/readback・個別Reset、styleのみmerge、effects OFF/ONの復帰、両Resetの独立性も正規artifactでassertした。

同じ全体座標のWhole cropと、異なるwindow origin・端のRegionがすべて一致した範囲では、中心の移動やPanによる輝度変化を示す差はない。
PNG一覧をローカル画像として確認し、正負補正とHighlight保護を確認した。
**ブラウザ操作、実RAW、実機Pan/Zoomの視認受入は未実施**。実機受入でちらつき・輝度の跳び・モード切替操作感を確認する。

## 残存Finding・性能

DX12指定の`highlightPriority / amount=-100 / midpoint=0 / highlights=100 / 2048 grid`で、
左上と左下の400×304 window、Draft/Full各1回、計4件が`cpu_fallback / gpu_failed`になった。
同じ条件のWholeはGPU成功、fallbackの画素差も0だった。
Nativeが通知するreason以上の失敗原因は未特定。この4件をGPU成功として数えず、後続の実機性能確認対象にする。
今回、Native改修やcontext/scheduler/cache/安全上限の変更は行わない。

合成素材・同一プロセスでのWhole Full 1024、stage cache有効の1組の要求時間はCPU cold/warm **75.483 / 63.405 ms**、
DX12 **60.652 / 52.590 ms**。coldはsource import coldではなくStageCache未生成を指す。
Regionのcache OFF要求時間（全設定/両grid/quality混在）はCPU min/median/max **10.866 / 29.892 / 36.994 ms**、
DX12指定 **19.710 / 30.599 / 74.525 ms**。IPC/PNG転送・decodeを含み、純粋な現像kernel性能ではない。
実RAW性能、RSS/VRAMは未測定。Phase 6Aの空間フィルター差の解消を意味しない。

## 自動検証

- Backend focused: controls/effects/detail/vignette/category/history/Recipe/restore/store/Native adapter、367件成功。
- 応答サイズのHTTPテスト2件を追加確認。上記200件上限と操作応答4,275 bytesを実測。
- Frontend focused: RAW UI/API/History/gesture/renewal/保存、共通フォーカス移動、JPEG調整pipeline、ショートカットを検証。修正後のfocused再実行を含め464件成功。
- TypeScript typecheck + production build成功。既存の大きいbundleに関するVite警告あり。
- RAW smoke成功: 管理artifact readiness、モック基盤を使うViewer lifecycle、Backend Recipe復元/Resetの各stage。実RAWの手動試験ではない。
- `git diff --check`成功。実機受入後のリリース文書更新は別作業。
