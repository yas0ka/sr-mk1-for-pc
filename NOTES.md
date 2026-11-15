# SR-MK1 for PC — 解析・検証メモ

アプリ名: **SR-MK1 for PC** (2026-11-15 決定。名前に「テプラ」「KING JIM」は入れない)

最終更新: 2026-11-15

## 環境

- PC: Windows 11、Bluetooth アダプタ TP-Link UB400 (CSR チップ, VID_0A12, 標準ドライバ)
- Python 3.11.9 (標準 `socket` の `AF_BLUETOOTH` / `BTPROTO_RFCOMM` を使用、追加ライブラリ不要)、Pillow
- SR-MK1: BT アドレス `60:8A:10:xx:xx:xx` (前半はメーカー番号)、Windows でペアリング済み (送信側 COM3 も生成されるが未使用)

## 接続

- Bluetooth Classic / RFCOMM **ch6** (SerialPort UUID 0x1101)。BLE ではない。
- スマホが接続中だと PC から見えないことがあるので、スマホ側の BT は切っておく。

## プロトコル (実機で確認済みの範囲)

参考: [nikachu2012/tepra_web PROTOCOL.md](https://github.com/nikachu2012/tepra_web) (SR-R2500P で実機確認、SR-MK1 は commandLevel 5 で同手順)、
[takustaqu/labelbridge docs/protocol.md](https://github.com/takustaqu/labelbridge/blob/main/docs/protocol.md)

- フレーム: `1B 7B <len> <cmd> <params> <chk> 7D` (len = 1 + params長 + 2, chk = (cmd + Σparams) & 0xFF)
- 送信順: 自動ステータス ON → Idle 待ち → ジョブ環境 (`@` `{ST` `C` `D` `G`) → 自動ステータス ON → ページ環境 (`L` 行数 LE32, `T` 余白 LE16) → ラスター行 → `0C` → `@` → PrintEnd 待ち → 自動ステータス OFF
- ラスター行: `1B 2E 00 00 00 01 <n LE16> <ceil(n/8) バイト>`、先頭ピクセル = MSB
- **リセット `1B 7B 03 21 21 7D` は送らない** (他機種で BT リンクが切れ、電源再投入まで戻らなかった報告あり)
- 終了時に自動ステータス通知を OFF (`1B 7B 05 49 00 00 49 7D`) に戻す

### ステータス応答 (92 バイト) — 資料との差分あり

- 先頭 13 バイト `40 42 44 43 20 53 54 32 0D 0A 50 00 3B` ("@BDC ST2\r\nP\0;")
- **実機ではその直後に 1 バイト (0x4E) が入り、ST/ER/TW は data[14]/[15]/[16]** (資料の表記より 1 バイト後ろ)
- 確認できた値: ST 0=Idle, 2=Printing, 5=PrintEnd / ER 0=正常 / TW 0x05=24mm, 0x03=12mm

### 向き (実機で確認)

- ラスター行はテープ長さ方向に並ぶ。**最初に送った行がラベルの右端 (読む向きで後ろ側) に来る** → 画像を左右反転してから送る。
- ヘッド方向 (上下) は先頭ピクセル = MSB = ラベル上端で正しかった。

### 印字ドット数 (360dpi)

| テープ | ドット | 状態 |
|---|---|---|
| 24mm | 256 | 実機確認 (枠が上下とも欠けず) |
| 12mm | 144 | 実機確認 (枠が上下とも欠けず) |
| 4 / 6 / 9 / 18mm | 44 / 72 / 108 / 216 | 資料の値、未確認 |

### カット

- `C` = 0x01010101 (毎ラベルでフルカット) で動作。
- ラベルの端ちょうどに描いた線はカットで欠ける → 両端に余白 (既定 2mm) を足して解決。

## 寸法の実測 (補正は保留中)

12mm テープ、「TEST テプラ」、両端余白 2mm で印刷 (2026-11-15):

| | 設計 (360dpi 想定) | 実測 |
|---|---|---|
| 黒枠の長さ | 582 ドット = 41.1mm | 40mm |
| ラベル全長 | 638 ドット = 45.0mm | 44mm |
| 前の余白 / 後ろの余白 | 2.0 / 2.0mm | 約 1.5 / 2.5mm |

- 送り方向が約 2.5% 短い (実効 約 370dpi 相当?)。定規の読み取り誤差の可能性もある。
- 余白の合計は一致しているので、印字位置が前に約 0.5mm ずれている (毎回同じずれと推定)。
### 目盛りラベルでの測定 (2026-11-15、12mm テープ、補正なし)

| | 設計 | 実測 |
|---|---|---|
| 目盛り 0〜100 | 100mm | 約 98mm |
| 左端〜0 | 5mm | 約 4.5mm |
| 100〜右端 | 5mm | 約 5.5mm |

- 上の 40mm での測定 (約 −2.5%、前寄り 0.5mm) とほぼ同じ傾向 → 個体の特性とみてよい。
- 補正値を保存: **送り倍率 0.98、前寄り 0.5mm** (`%APPDATA%\SR-MK1 for PC\config.json`。この個体だけの値)
- **確認済み (2026-11-15)**: 補正をかけた目盛りラベル (`ruler --calibrated`) で、0〜100 = 100mm、両端の余白 5mm / 5mm に揃った (12mm テープ)。
- **未確認**: 24mm テープでも同じ倍率でよいか。

## ファイル

- `tepra/` — ライブラリ本体
  - `protocol.py` コマンド生成・ステータス解析・テープ幅表
  - `transport.py` RFCOMM 接続とステータス受信
  - `render.py` ラベル画像 → ラスター行 (左右反転・余白・寸法補正)、テスト用の文字ラベルと目盛りラベル
  - `printer.py` 印刷ジョブ (複数ラベル対応、毎ラベルでカット)
  - `config.py` 接続先と補正値。`%APPDATA%\SR-MK1 for PC\config.json` に保存 (既定はプリンタ未設定・補正なし)。
    開発中の保存場所 `%APPDATA%\tepra-mk1` があれば、初回起動時に丸ごと写す (元は残す)
- `cli.py` — `status` / `print` / `ruler` / `calibrate` / `config`
- `app/` — ラベルアプリ (pywebview)。`python app/main.py` で起動 (`--debug` で開発者ツール)
  - `api.py` 画面から呼ぶ Python API。プリンタとの接続を保ち、4 秒ごとに状態を取得
  - `web/label.js` 文字ブロックの描画 (横書き・縦書き・自動フィット・揃え・装飾)、2 値化・網点
  - `web/objects.js` ラベルに置く部品 (文字ブロック・表・QR/バーコード)。Fabric.js のオブジェクト
  - `web/editor.js` 編集画面 (配置・揃え・グループ・元に戻す・書き出し)。シーン座標はドット
  - `web/app.js` ツールバー・右パネル・プリンタ状態・印刷、`web/mock.js` ブラウザ単体で確認するための疑似 API
  - `web/doc.js` 複数ラベルのファイル (タブ・開く/保存)、連番・日付の設定欄、印刷ジョブの進み具合、印刷履歴
  - `web/vars.js` 連番・日付の計算。`{連番1}` `{日付1}` を文字・コードの内容・表のセルに書くと印刷時に置き換わる
  - ファイル形式: `{ app: "tepra-mk1", version: 2, labels: [{ name, label, objects, seqs, dates }] }` (.json)
  - 印刷は 1 ラベル = 1 ジョブで順に印刷し、終わるのを待ってから次へ (止まった所から「続きから印刷」できる)
  - 印刷履歴: `%APPDATA%\SR-MK1 for PC\history.json` (最新 50 件。合計 600KB までなら印刷画像も残し「もう一度印刷」できる)
  - `web/vendor/` Fabric.js 6.4.3 (MIT)、bwip-js 4.5.1 (MIT) を同梱 (オフラインで動く)
  - 作りかけのラベルと設定は WebView の localStorage (`%APPDATA%\SR-MK1 for PC\webview`) に残る
  - bwip-js は QR コードを 1 モジュール = scale×2 ピクセルで描く (1 次元バーコードは scale×1)
  - ブラウザで画面だけ確認: `python -m http.server 8765 --directory app/web` → http://localhost:8765/?mock
    (`?mock&setup` で初回起動の画面、`?mock&nofound` で SR-MK1 が見つからない場合。`?mock` がないときは疑似 API を使わない)
- アプリが接続している間は、スマホアプリからは SR-MK1 に接続できない (RFCOMM は 1 台ずつ)

## 実機で確認した動作 (フェーズ 1)

- 複数ページの連続印刷 (部数 2): 1 ジョブ内で page_env → ラスター → FF を 2 回繰り返し、最後に `@`。エラーなく完了し、ラベルは 1 枚ずつカットされて出た (C = 0x01010101 毎ラベルカット、2026-11-15)
- 接続を保ったままのステータス取得: 初回 1.8 秒 (接続込み)、2 回目以降 0.4 秒

## 実機で確認した動作 (フェーズ 2)

- アプリを起動し、画面側の印刷処理 (編集画面の書き出し → Python → プリンタ) で「E2E テスト」+ QR コードのラベル (約 58.6mm) を 1 枚印刷。エラーなく完了 (2026-11-15)
- 印刷した QR コード (12mm テープ、1 モジュール 4 ドット) はスマホで読み取れた
- 未確認: 縦置きラベルの実物の向き、1 次元バーコードの読み取り

## 実機で確認した動作 (フェーズ 3)

- アプリの画面側の印刷処理で「No.{連番1}」を部数 3 で印刷 → 3 ジョブ順に完了し、No.001〜003 が 1 枚ずつ番号どおりに出た。履歴に記録、連番は次回 004 から (2026-11-15)
- 途中で止まったときの「続きから印刷」と中止は、疑似 API でのみ確認 (実機でテープ切れやカバー開けは未確認)

## フェーズ 4 (ケーブル用ラベル)

テプラ クリエイターのマニュアル (PDF 版 p127〜138) を参照。

- フラッグラベル: `[旗 A][巻き付け部分][旗 B]`。巻き付け部分 = 直径 × π + 0.5mm。旗の長さ 5〜300mm (片側、余白込みの実長)
  - レイアウト AA｜AA / AA｜BB / CC｜CC / CC｜DD (CC は縦向き)、目印 4 か所 / 中心線 / なし
  - 貼り合わせると A と B が背中合わせになり、B は A と同じ向きのまま印刷すれば反対の面から正しく読める
  - 設定はラベルの `template` に持ち、変えるとひな形の部品 (`tpl: true`) だけ作り直す
  - 実機: 12mm テープ・LAN ケーブル (6mm)・旗 25mm の AA｜AA を 1 枚印刷 (全長 69.3mm)、エラーなく完了。ケーブルに巻いて旗にでき、両面とも読めた (2026-11-15)
- ケーブル表示ラベル: 純正では専用の「ケーブル表示ラベル」テープを使うときだけの機能。
  このテープはステータスの TW が 0x11 / 0x12 で、下位 4bit だけ見ると 6mm / 9mm と誤認していたので、
  「ケーブル表示ラベル用テープ (未対応)」として扱い、印刷しないようにした。印字ドット数が分からないため対応は保留
- 旧 `probe.py` / `tepra_print.py` は `cli.py` に置き換え (git 履歴に残っている)

## 寸法補正の手順

1. `python cli.py ruler` で 100mm の目盛りラベルを印刷 (補正なし、両端余白 5mm)
2. 「目盛り 0〜100 の長さ」「左端〜0」「100〜右端」を測る
3. `python cli.py calibrate --scale <0〜100> --front <左端〜0> --back <100〜右端>`
   - 送り倍率 = 実測 / 100、前寄り = (後ろ − 前) / 2
   - アプリでは「設定」→「寸法の補正」で同じことができる

## 配布の準備 段階 A (アプリの手直し)

- プリンタのアドレスと寸法補正をコードに書かない。初回起動 (アドレス未設定) で「はじめの設定」を出す:
  はじめに → ペアリング (レジストリ `HKLM\SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Devices\<アドレス>` の `Name` から
  ペアリング済みの SR-MK1 を探す。管理者権限なしで読める) → 接続テスト (つながったら保存) → テスト印刷 (任意) → 完了
- 「設定」画面: プリンタの選び直し / 寸法の補正 (目盛りラベルを印刷して 3 か所を入れる) / 画面の実寸 /
  困ったとき (診断情報のコピー。アドレスは後ろ半分を伏せる、ログのフォルダ) / このアプリについて (非公式・商標・無保証・ライセンス)
- ログ: `%APPDATA%\SR-MK1 for PC\logs\app.log` (500KB × 4)。画面側のエラーも `log_client` で残す
- エラー文は「何が起きたか + どうすればよいか」にする (`app/support.py` の friendly_error、`protocol.ER_ADVICE`)。
  電源の入っていない機器への接続は WinError 10060 (約 5 秒) で失敗する
- テスト印刷・目盛りラベルは履歴に残さない。目盛りは補正なしで印刷 (確認用は補正つき)
- 確認 (2026-11-15): 空の設定フォルダで本物の pywebview ウィンドウを開き、はじめの設定が出て疑似 API を使わないこと、
  ペアリング済みの実機 SR-MK1 が見つかること、接続テストでつながって設定に保存されることを確認。
  テスト印刷と目盛りラベルの印刷は、利用者がアプリから実機で試して問題なし。実機のエラー表示 (テープ切れなど) は未確認

## 配布の準備 段階 B (配布ファイルを作る)

- `powershell -ExecutionPolicy Bypass -File packaging\build.ps1` で、`dist\` に次を作る
  - `SR-MK1 for PC\` アプリ本体 (PyInstaller の 1 フォルダ形式、`packaging\sr-mk1-for-pc.spec`)
  - `SR-MK1-for-PC-<版>-setup.exe` インストーラー (Inno Setup 6、`packaging\installer.iss`)。
    管理者権限なしで `%LOCALAPPDATA%\Programs\SR-MK1 for PC` に入る。スタートメニュー、デスクトップ (任意)、
    アンインストールに対応。設定と履歴 (`%APPDATA%\SR-MK1 for PC`) はアンインストールしても残る
  - `SR-MK1-for-PC-<版>-portable.zip` インストールしない版
- ビルド用の Python 環境は `.venv` (git に入れない): `python -m venv .venv` → `.venv\Scripts\pip install -r packaging\requirements-build.txt` (版を固定。Actions も同じ)
- Inno Setup は `winget install JRSoftware.InnoSetup --scope user` で入れた (日本語の画面あり)
- build.ps1 と installer.iss は日本語を含むので UTF-8 (BOM 付き) で保存する (BOM がないと Windows PowerShell 5 が文字化けする)
- 版の番号は `app/version.py` の 1 か所だけ (exe のプロパティ・インストーラー名に使う)
- アイコン: `packaging/make_icon.py` で作る (`app.ico`)
- WebView2 ランタイムがない PC では、起動時にメッセージを出してダウンロードページへ案内する (Windows 11 には最初から入っている)
- 配布版は起動に失敗したときもメッセージボックスで知らせる (コンソールがないため)
- 確認 (2026-11-15): ビルドした exe を Python なし相当で起動し (空の設定フォルダ)、画面が出てログに「画面の準備ができました」が残ること。
  サイズ: インストーラー 16.3MB、zip 19.6MB

## 配布の準備 段階 C (日本語のマニュアル)

- `README.md` (GitHub の入口: 何ができるか・ダウンロード・必要なもの・商標とお断り) と `docs/`
  - `getting-started.md` はじめかた (ダウンロード時・インストール時の警告の進め方、ペアリング、最初の印刷)
  - `usage.md` 使い方 / `faq.md` 困ったとき / `limitations.md` できないこと・注意
- ダウンロードへのリンクは `../../releases/latest` (README から見た相対リンク。アカウント名を書かずに済む)
- 画面写真 `docs/images/*.png` は `packaging\screenshots.ps1` で撮り直せる
  (疑似 API の `?mock&demo=main|flag|setup|calib` で見本の状態を作り、Edge の headless で 1280×800 を撮る)
- 用語は画面に合わせて「プリンタ」「アダプタ」(「プリンター」にしない)

## 配布の準備 段階 D (公開の準備)

- ライセンス: このアプリは MIT (`LICENSE.txt`、著作権者は GitHub のアカウント名 yas0ka)
- 同梱ソフトのライセンス表示 `THIRD_PARTY_NOTICES.txt` は `packaging/third_party.py` で作る (build.ps1 が毎回作り直す)。
  全文はビルド環境の dist-info・vendor の LICENSE・Python の LICENSE.txt から写す。
  WebView2 SDK の全文はパッケージにないので、NuGet の License ページから `packaging/licenses/` に保存した
- 配布物の exe と同じフォルダに LICENSE.txt / THIRD_PARTY_NOTICES.txt / はじめにお読みください.txt を置く。
  アプリの「このアプリについて」から開ける (`open_notice`)
- リポジトリ: https://github.com/yas0ka/sr-mk1-for-pc (`app/version.py` の REPO_URL)。Issue のひな形は `.github/ISSUE_TEMPLATE/`
- 公開用の履歴は新しく始めた (ブランチ main、作者は GitHub の noreply アドレス)。
  開発中の履歴はローカルのブランチ `dev-history` にだけ残す (push しない。push するのは main だけ)

## 配布の準備 段階 E (公開)

- `.github/workflows/release.yml`: `v<版>` のタグを push すると、GitHub の Windows でビルドして Releases に公開する。
  0.x の版はプレリリース (ベータ版)。タグと `app/version.py` の版が違うと止まる。手動で動かすとビルドだけ
- リリースの説明文は `packaging/release-notes.md`
- 新しい版を出す手順: `app/version.py` の VERSION を上げる → コミット → `git tag v<版>` → `git push origin main v<版>`
