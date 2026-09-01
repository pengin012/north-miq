# north / Make it a quote PoC

公開northポストの読み取りと、`@make_it_a_quote` へのメンションを起点にしたMIQ画像生成を行うPoCです。画像は公式のMake it a Quote互換レンダラーのdarkテーマを使い、Discord版に近い黒背景・カラーアイコン・引用文・名前/ハンドルの構成で生成します。

このプロジェクトはnorth.rip、Discord、Make it a Quoteの運営元とは無関係です。northの公開Web APIは公式Bot APIとして公開されたものではないため、利用規約・運営の許可・仕様変更を確認したうえで使用してください。

## 安全なドライラン

```powershell
npm.cmd run poc -- https://north.rip/1145141919810/status/2094508520291435125 --text "PoC引用テスト"
```

既定では公開APIへの読み取りだけを行い、投稿リクエストは送信しません。

## メンション監視とMIQ生成

ChromeのCookieを手でコピーせず、Bot専用のローカルブラウザプロファイルを使ってセッションを準備できます。

```powershell
npm.cmd install
npm.cmd run session:setup
```

開いたChromeで `@make_it_a_quote` に手動ログインしてください。Cookieの値は表示せず、`data/north-session.cookie` にだけ保存します。

Cloudflareがこの自動操作ブラウザをブロックする場合は、`session:setup` を繰り返さないでください。現在ログイン済みの通常ChromeでDevToolsのNetworkからnorthのリクエストを「Copy as cURL」し、cURL内の `Cookie:` の後ろの値だけを、次のローカルファイルへ保存します。Cookie値をチャットへ貼らないでください。

```powershell
notepad "data\north-session.cookie"
```

保存後は、セットアップと同じように `npm.cmd run miq -- --once` でセッションを確認できます。`401` ならCookieのコピーを確認し、`403` が続く場合はNode.jsからの直接利用がCloudflareに拒否されている状態なので、通常Chromeを維持したブラウザ接続方式へ切り替えます。

セッション準備後、まずドライランで実行します。

```powershell
npm.cmd run miq -- --once --process-existing
```

この処理は、`@make_it_a_quote` へのメンション通知を読み、返信元の `inReplyToId` を親ポストとして取得します。親ポストの本文とnorth内の投稿者アイコンからPNGを生成し、`data/miq-previews/` に保存します。

初回起動時は既存通知を基準点として保存し、過去のメンションを勝手に処理しません。過去分も確認したい場合だけ `--process-existing` を指定してください。

ドライランでは新しい通知を処理済みにしないため、プレビューを確認した後、同じ通知を `--post --confirm-public` で投稿できます。

常時監視は最低15秒、既定30秒です。

```powershell
npm.cmd run miq -- --interval 30
```

## 投稿モード

投稿モードは、ローカル環境変数 `NORTH_SESSION_COOKIE`、`NORTH_SESSION_COOKIE_FILE`、またはセットアップが作る `data/north-session.cookie` と、明示的な `--post --confirm-public` が必要です。
Cookieはパスワード相当として扱い、チャットへの貼り付け・Gitへのコミット・ログ出力をしないでください。

```powershell
npm.cmd run miq -- --once --process-existing --post --confirm-public
```

投稿すると、Botはメンションされた返信に対して、生成したMIQ画像を添付して返信します。既定ではnorthのネイティブ引用ではなく、MIQ画像として返します。

このセットアップは現在使っているChromeのプロファイルを読みません。別プロファイルで一度だけログインします。常時運用には、north運営が提供する公式Bot/API認証、またはこの専用セッション方式が必要です。

## OSSセキュリティ

`.env`、Cookie、ブラウザプロファイル、セッションファイル、生成画像、依存パッケージはGit管理対象外です。セッションやCookieをIssue、Pull Request、ログ、スクリーンショットへ貼り付けないでください。

設定項目の名前だけは [.env.example](.env.example) にあります。実値はローカル環境で設定してください。
