# LightCraft 統合研究資料

GenzoRoomのLightCraft統合を判断するための研究記録。統合実装の仕様確定や完了報告ではない。
収録日：2026-10-20（Asia/Tokyo）。収録先ブランチ：`feature/lightcraft-integration`。

## 資料索引

| 文書 | 内容 |
|---|---|
| [BASELINE.md](BASELINE.md) | 基準バージョン・commit、crate構成、Rust・Docker条件、ライセンス |
| [POC_RESULTS.md](POC_RESULTS.md) | Windows/Linuxの既存実測、画像比較、Docker資材、QNAP未検証事項 |
| [ENGINE_API.md](ENGINE_API.md) | CLI/MCP、Session、ソース・段階キャッシュ、Preview、DevelopSettings、Process Version、XMP入出力仕様 |
| [INTEGRATION_DESIGN.md](INTEGRATION_DESIGN.md) | 統合候補比較、常駐MCPの最小PoC案、Rust Adapter案、受入条件、XMPバックアップ・交換候補 |
| [V0.10.0_CHANGES.md](V0.10.0_CHANGES.md) | v0.9.1からv0.10.0のソース差分、互換性・統合設計への影響、未検証事項と採用済み開発方針 |
| [GPU_POC_V0.10.0.md](GPU_POC_V0.10.0.md) | Windows 11／Radeon RX 580のDX12常駐MCP実機PoC、GPU／CPUのPreview・Export実測と残存課題 |
| [PHASE1A_DESIGN.md](PHASE1A_DESIGN.md) | Windows Python Backendによる常駐MCP管理のPhase 1A設計案、現行構造、テスト計画、未検証事項 |
| [PHASE1B_DESIGN.md](PHASE1B_DESIGN.md) | 未実装のPhase 1B設計：固定v0.10.0のRAW／設定／Preview API、画像応答上限、Session・revision管理、要求集約、実装・テスト計画 |
| [PHASE1C_DESIGN.md](PHASE1C_DESIGN.md) | 設計段階：実装済みRAW／JPEG送信の追跡、既存暗室へのRAW接続、Slider対応、Windows API・Preview制御、Session容量、一時編集と後続永続化／Exportの境界、工程・受入条件 |

## 出典と収録方針

- 元資料A：`I:\code\raw-test\research-poc.md`（2026-10-20）。Windows/Linux現像PoCの記録とソース調査。
- 元資料B：`I:\code\raw-test\lightcraft-v0.9.1-genzoroom-integration-investigation.md`（2026-10-20）。Windows版GenzoRoom向けのAPI・接続方式のソース調査。
- 根拠ソース：`I:\code\lightcraft`。今回の読み取りでもHEADとv0.9.1が基準commitに一致し、detached HEAD、作業ツリーcleanであることを確認した。
- 元資料の本文を節単位で再配置し、数値、制約、ローカルソース参照、証拠の限界を維持した。節番号は元資料Bの番号を残している。
- ローカル絶対パスのソースリンクは調査環境用で、別環境には自動追随しない。行番号は固定commitに対する参照。テスト画像、JPEG、ログ、Dockerイメージなどの実体はこのディレクトリへコピーしていない。
- 元資料末尾の「変更範囲」「実施範囲」は各元調査当時の記録。この収録作業では指定の研究文書5件と既存文書2件の参照だけを変更する。

## 証拠区分と現在の状況

| 区分 | 意味・状況 |
|---|---|
| 確認済みの事実（ソース） | 基準commitの実装・定義に存在する経路。実行成功や将来互換性は意味しない |
| 既存実測結果 | 元資料AのWindows/Linux PoC。ログ由来と会話記録由来を本文で区別。今回再実行・再計測していない |
| 設計提案・推奨 | 元資料Bの統合比較・最小PoC、設定保存・要求集約の案。GenzoRoom側の適合や実装量を確定していない |
| 未検証・未確定 | GenzoRoom実接続、対話性能、QNAP実機、主観画質、差分原因、正式ライセンスレビューなど |

今回のソース確認では、workspace version/Rust baseline/license/NOTICE、CLIのstdin読込とMCP起動、HeadlessのSession保持・同期Preview・Export既定サイズ、MCP画像返却、GPU無効化、SourceLevel・StageCache初期値、Process Version・WB部分mergeの注意点を照合した。全文中のすべてのソース経路を再監査したという意味ではない。
ソース確認の追加事項として、NOTICEにsegment crateのApache-2.0限定、別配布モデルやフォント等の個別条件がある点をBASELINEへ記載した。

今回ビルド、自動テスト、CLI現像、MCP実接続、ブラウザ操作、NAS操作は行っていない。新たな性能・画質の測定結果はない。

追加依頼のXMP調査ではLightCraftのmetadata・sidecar・import/export実装と既存テスト、GenzoRoomのRecipe・編集状態・JPEG metadata・Immich upload実装を読み取った。結果はENGINE_APIとINTEGRATION_DESIGNに記載した。Immichについてはリンク先の公式文書上の仕様と実環境の未検証事項を区別している。

## 元資料の収録対応

| 出典 | 収録先 |
|---|---|
| A：冒頭・要約・変更範囲 | 本索引（過去の調査記録） |
| A：バージョン、crate構成、Linux/Docker・WASM・ライセンス | BASELINE |
| A：検証履歴、Docker/QNAP準備、ログ所在、残存事項 | POC_RESULTS |
| A：DNG寸法、previewOnly、CLI設定JSON・Process Version | ENGINE_API |
| B：1章・9章 | 本索引（調査条件・実施範囲） |
| B：2〜5章 | ENGINE_API |
| B：6〜8章 | INTEGRATION_DESIGN |

元資料の表題はA「LightCraft 調査・RAW現像PoC記録」、B「LightCraft v0.9.1 — GenzoRoom Windows版への統合調査」。Bの調査・文書化日も2026-10-20。表題と節グループ見出しを再構成した以外、本文の行は元資料との照合で収録を確認した。

## 元資料Aの概要

- 作成日: 2026-10-20（Asia/Tokyo）
- 対象: LightCraft公式リポジトリ `I:\code\lightcraft`
- 用途: GenzoRoom（AGPL-3.0-only、Immich連携RAW/JPEG現像Webアプリ）との統合判断、およびQNAP TS-664上でのCPU現像PoC準備
- 作業範囲: 調査、Windows/Linux現像PoC、Dockerイメージ作成・保存、配備手順作成。GenzoRoom連携とQNAP実機実行は未実施。

## 要約

- v0.8.0（基準commit `f34c7a8a89e0d1bade0a6889185f40acecc84a9f`）とv0.9.1（タグcommit `4f0b110bcbd2e350c6d97b47f1d824c2222295c4`）を検証した。現在のLightCraft作業ツリーはv0.9.1のdetached HEADでclean。
- CLIはGUIを開かずRAWを読み込み、現像してJPEGへ書き出せる。Pixel標準DNGとPentax DNGはWindowsとLinux DockerのCPU現像で成功した。
- Pixelの旧 `sample.dng` では、当時のユーザー申告RAW寸法4080×3072に対し、v0.8.0 CLI出力は1106×830だった。現在の同パスのファイルは4,557,556 bytesだが、当時の入力SHA-256が保存されていないため、同一ファイルかは確定できない。新しい `sample2.dng` はLinux v0.9.1で4064×3056。旧画像の縮小段階・原因を特定できる数値RAWタグ記録は残っていない。
- v0.8.0とv0.9.1のWindows版デフォルト出力は、Pixel/PentaxともSHA-256が一致した。Linux版はSHA-256こそ異なるが、画素比較では差分画素が各0.3%未満、MAEは0.004未満。
- Linux Dockerの最大RSSはPixel 1,089,004 KiB（約1.04 GiB）、Pentax 1,675,444 KiB（約1.60 GiB）。QNAP実機では未測定。
- Dockerイメージは `linux/amd64` でビルド・現像・保存済み。QNAPへの転送、ロード、実行は未実施。

## 元資料Bの調査条件・証拠の読み方

## 1. 結論と調査条件

LightCraft v0.9.1は、Windowsネイティブ版GenzoRoom（Tauri 2＋WebView2＋Python Backend）からRAW現像エンジンとして利用できる構造を備えている。最小PoCは既存CLIの常駐headless MCPモードで構成でき、LightCraft本体の変更は不要である。ただし、スライダードラッグ中の応答性を重視する場合は、`Session`と`StageCache`を保持する専用Rustプロセスが有力である。

これはコードから判断した統合可能性であり、今回GenzoRoomとの実接続やWindowsでの対話操作性能を検証したという意味ではない。

### 基準

- 対象リポジトリ：`I:\code\lightcraft`
- 基準バージョン：`v0.9.1`
- 基準commit：`4f0b110bcbd2e350c6d97b47f1d824c2222295c4`
- 調査時のHEADは基準commitと一致。detached HEAD。
- ワークスペースのバージョンも`0.9.1`。
- 調査時の作業ツリーに変更なし。
- Pixel 7 ProおよびPentax DNGのWindows CLI／Linux DockerでのRAW現像・JPEG出力成功は、依頼者による既存検証として扱った。今回は再検証していない。
- 調査ではコード変更、ビルド、依存更新、実装、GenzoRoom側コードの調査・変更を行っていない。
- 本文書の作成でもソースコード変更、Commit、Pushは行わない。

### 証拠の読み方と制限

- **実装済み**：基準commitのコードに該当する経路・APIを確認したもの。今回の実行成功を意味しない。
- **未実装／確認した経路にない**：調査した既存インターフェースでは提供されていないもの。
- **未確認**：実測、実接続、配布バイナリの確認などを行っていないもの。
- **推奨**：コード上の事実から導いた設計案。実装済み機能とは区別する。
- ソースへのリンクは調査時のローカル絶対パス。行番号は基準commitの調査時点を指し、upstream更新後には変わり得る。
- ローカル専用の`plan/STATUS.md`、`plan/execution-plan.md`、`plan/architecture.md`は存在しなかった。
- コードコメントが参照する`docs/pipeline.md`も存在しなかったため、実装を優先した。
- `docs/gaps.md`には「Process VersionはV1のみ」という記述がある一方、実装にはV2がある。文書と実装の不一致であり、本調査では実装を採用した。

## 元調査の実施範囲（当時の記録）

## 変更範囲

この資料のみ新規作成。LightCraftソース、Cargo定義、GenzoRoom、テスト入力、既存JPEG、Docker資材は変更していない。Commit/Pushなし。

## 9. 調査・文書化の実施範囲

本調査は指定commitのソースと関連文書の読み取りに基づく。自動テスト、ビルド、CLI実行、GUI／ブラウザでの動的確認、RAW現像の再検証は行っていない。本Markdownの保存以外の実装作業、ソースコード変更、Commit、Pushは行っていない。
