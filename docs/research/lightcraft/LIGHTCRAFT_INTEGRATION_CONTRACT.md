# GenzoRoom / LightCraft 恒久統合契約

この文書は今後のLightCraft更新に共通する責務と接続の原則を定める。現行動作は [architecture](../../architecture.md)、v0.20.0の移植手順と履歴は [移植計画](LIGHTCRAFT_V020_UPGRADE_PLAN.md) を参照する。

## 責務境界

GenzoRoomは「何を現像するか」を要求し、LightCraftは「どう現像するか」を判断する。Immichは写真原本を管理する。

| GenzoRoom | LightCraft |
|---|---|
| Immich接続・STACK管理 | RAW／JPEG等のデコード |
| 編集UI・操作イベント・現像パラメーター送信 | パラメーターの解釈・画像処理 |
| Preview要求・表示・更新、要求世代・revision・stale応答管理 | Whole／Region／Before／Draft等の画像生成 |
| Crop枠・スポイト位置等のUI座標管理 | Crop／Straighten／WBの計算 |
| Recipe／History／DB、Undo／Redo等の操作管理 | GPU／CPU選択とfallback、StageCache・メモリ管理 |
| Export Queue、生成ファイルの寿命管理・Immich登録 | 現像画像の生成・エンコード・Export |

GenzoRoomは通信・session・操作エラーを扱い、原本の意図しない変更・削除を防ぐ。LightCraftの現像アルゴリズムや設定解釈を複製しない。

## 接続API

アプリケーション機能に必要な入力・出力に限定する。対象には編集settings、描画対象・品質・領域、生成画像、UI座標に必要なGeometry、操作結果・エラー、Export成果物を含む。要求と結果の対応および必要な座標系を明確にし、基本的な型・範囲・サイズ、通信と操作の成功、永続データの整合性を確認する。未知のNative設定は保存・復元を妨げない範囲で保持する。

次はGenzoRoomの公開接続契約に含めない。

- StageCache ON／OFF、内部キャッシュ容量・保持量・budget、admission制御
- GPU execution詳細、CPU fallbackの内部理由
- 内部Render Plan全体、エンジン内部buffer・allocation情報

診断専用の内部情報をPreview成功判定の必須条件にしない。LightCraft標準APIで実現できる機能には独自APIを追加せず、標準APIが不足する場合のみ必要な情報・操作を公開する最小限のNative patchを追加する。

## Native patchと成果物の管理

1. 正式tagと固定upstream commitを記録し、標準APIとの差分から各patchの必要性を判断する。エンジン内部の変更を不要に複製・改変しない。
2. patchごとに目的、変更箇所、公開API、必要な理由、変更ファイル数と追加・削除行数を記録し、更新ごとの肥大化を追跡する。
3. cleanな固定upstreamに全patchを再現可能に適用し、部分適用・重複適用を失敗として扱う。現行の `native/lightcraft/build.py` とmanifestによるcommit・patch digest・targetsの検証を維持する。
4. Native build成果物の実binary、manifest、receipt、patch、固定commitの整合を確認する。versionだけでなく実binaryのschema・応答種別とSHA-256 receiptを検証する。
5. 次回更新では旧patchを機械的に全面移植せず、上流標準APIと必要なアプリケーション機能を再評価する。上流標準で実現可能になった独自APIのpatchは削除候補とし、同等機能の確認後に廃止する。

現在のmanifestはv0.18.1の固定commitと有効な `0002`／`0003` patchのdigest・targets・目的を管理し、旧版patchも履歴として存在する。開発中の累積暫定patchは成果として保持し、正式採用時には必要な接続のみのmanaged patchに整理する。実際の手順は [更新ガイド](UPDATE_GUIDE.md) を参照し、過去の契約固有の記述は現行実装や履歴として扱う。
