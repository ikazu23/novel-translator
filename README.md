# 韓国小説・WT 丸ごと翻訳

**韓国語・中国語・英語**の小説を、ページを開いたまま自然な日本語で読めるスクリプトです。
1文ずつではなく話全体の流れを見て訳すので、呼び方や口調がそろいます。太字・色・空行などの見た目もそのままです。
**漫画・ウェブトゥーン**の吹き出しも、画像の上に訳を重ねて読めます（WTモード）。

[![作者を応援する（OFUSE）](https://img.shields.io/badge/%E2%98%95_%E4%BD%9C%E8%80%85%E3%82%92%E5%BF%9C%E6%8F%B4%E3%81%99%E3%82%8B-OFUSE-e91e63?style=for-the-badge)](https://ofuse.me/ikasumi)

> **English:** Translate Korean / Chinese web novels and webtoons into English right on the page — [see below](#english).
>
> **中文：** 在网页上直接把韩国网络小说和条漫翻译成中文 —— [点此查看](#中文)。

## できること

- 本文をその場で日本語に置き換え（サイトの見た目のまま）
- 原文の言語（韓国語・中国語・英語）を自動で判定
- 人物・用語メモを作品ごとに自動で作って、話をまたいで訳をそろえる
- 一度訳した話は保存されるので、開き直しても料金はかからない
- GitHubへの自動バックアップ（スマホを無くしても戻せる）
- **WTモード**：漫画・ウェブトゥーンの吹き出しを読み取って、吹き出しの上に訳を重ねる

---

## 1. 入れ方

1. ブラウザに拡張機能の **Tampermonkey** か **Violentmonkey** を入れる
   - **Android**：Firefox か Edge
   - **iPhone / iPad**：
     - Safari ＋ App Storeの Tampermonkey（有料・500円ほど）
     - または **Orion ブラウザ** ＋ Violentmonkey（無料）：Orionで [Violentmonkey のページ](https://addons.mozilla.org/firefox/addon/violentmonkey/) を開いて追加
       - ※ Orionは拡張の対応が完全ではなく、挿絵・WTの翻訳がうまくいかないことがあります。安定して使いたい場合は Safari ＋ Tampermonkey がおすすめです
   - **PC**：Chrome・Edge・Firefox
   - 無料の **Violentmonkey** でも使えます（[Firefox用](https://addons.mozilla.org/firefox/addon/violentmonkey/)・AndroidのFirefoxも同じページから）
2. 下のリンクを開いて「インストール」を押す（Tampermonkey・Violentmonkey どちらも同じリンク）

👉 **[スクリプトをインストール](https://raw.githubusercontent.com/ikazu23/novel-translator/main/korean-novel-translator.user.js)**

> 拡張機能が使えないブラウザでは使えません。

### 試験版（新しい機能を先に試したい人向け）

👉 **[試験版をインストール](https://raw.githubusercontent.com/ikazu23/novel-translator/main/korean-novel-translator.beta.user.js)**

- 直したばかりの機能を先に使えます。そのぶん、不具合が出ることもあります
- 入れると、今のスクリプトが試験版に置き換わります（2つ同時には入りません）。保存した訳・設定はそのまま使えます
- 試験版を入れた人には、試験版の更新が届きます
- 元に戻すときは、上の「スクリプトをインストール」から入れ直してください

### うまく入らないとき
- **インストール画面が出ずにコードが表示される** → Tampermonkeyの「ダッシュボード」→「ユーティリティ」→「URLからインストール」に、上のリンクのアドレスを貼る
  （Violentmonkeyなら、アイコン →「⚙」→「＋」→「URLからインストール」）
- **iPhoneのOrionでコードが表示されるだけ** → Orionではリンクを開いてもインストール画面が出ません。Violentmonkeyのアイコン →「⚙」（ダッシュボード）→「＋」→「URLからインストール」に上のリンクを貼ってください。それでもだめなら「＋」→「新規」を押して、出てきた中身を全部消し、上のリンクのコードを全部コピーして貼り付けて保存（あとの更新は自動で届きます）
- **iPhone / iPadで動かない** → 「設定」→「アプリ」→「Safari」→「機能拡張」→「Tampermonkey」で「すべてのWebサイト」を「許可」にする
- **PCのChrome / Edgeで動かない** → 拡張機能の管理画面で「デベロッパーモード」をオンにして、Tampermonkeyの「ユーザースクリプトを許可」をオンにする

---

## 2. APIキーを用意する

おすすめは **Gemini**（安い・速い・成人向けも訳せる）。

1. [Google AI Studio](https://aistudio.google.com/) でAPIキーを作ってコピー
2. 支払い（課金）を設定する ※無料のままだと回数制限がきつく、送った文がGoogleの学習に使われることがあります

ほかに Claude や DeepSeek も使えます。

---

## 3. 最初の設定

小説のページで右下の **⚙** を押して設定を開きます。

| 項目 | 入れるもの |
|---|---|
| エンジン | Gemini |
| APIキー | 2.で作ったキー |
| モデル名 | 空欄でOK |
| 1回に送る文字数 | **10000**（安くなる） |
| 同時に送る数 | **1** |
| 冒頭を先に表示する | **オフ**（安くなる。オンだと速いけど少し高い） |

最後に **保存** を押します。

設定画面のいちばん上の **「小説」「WT」** で、設定の中身が切り替わります。
WTの設定は、APIキーなどを空欄にしておけば小説と同じものを使います。WTの「同時に送る数」は **3** がおすすめ（エラーが多いなら2）。料金は変わらず、速さだけが変わります。

---

## 4. 使い方

| ボタン | 動き |
|---|---|
| **訳**（青） | 翻訳する。翻訳中はまわりがくるくる回ります |
| **原**（緑） | 原文に戻す |
| **⚙** | 設定 |

- ボタンは指でドラッグして、好きな場所に動かせます
- 表示されている文だけが文字になっているビューア（カカオページなど）は、読み進めたらまた「訳」を押してください

### 小説モードとWTモード
設定画面を **「小説」タブのまま閉じると小説モード**、**「WT」タブのまま閉じるとWTモード** になります（サイトごと）。

小説モードでも、**挿絵の中の文字** は「訳」を押すと一緒に訳されます（「原」で原文に戻る）。一度訳した挿絵は、開き直しても料金なしで表示されます。いらなければ設定の「挿絵の中の文字も訳す」をオフにしてください。

### WTモード（漫画・ウェブトゥーン）
右下が **⚙** と **WT** ボタンになります。

| ボタン | 動き |
|---|---|
| **WT** | そのページの翻訳を始める。スクロールした先もそのまま訳していきます |
| **WT**（翻訳中にもう一度） | 一時停止して原文に戻す。もう一度押すと続きから再開 |
| **WT**（長押し） | WTの設定 |

- ページを開いただけでは送りません（料金なし）。**WTを押してから** 翻訳します
- 前に訳した画像は、押さなくても最初から訳が出ます
- 訳をタップすると原文が見えます
- 初めての漫画サイトでは、画像を読み込む許可を聞かれることがあります。「常にドメインを許可」でOK

### Tampermonkeyのメニューでできること
- **この話を翻訳し直す**：訳が気に入らないとき（料金がかかります）
- **エンジンを切り替え**：ClaudeとGeminiの訳を両方残して見比べられる
- **原文の言語を切り替え**：自動判定がうまくいかないとき
- **WT（まんが・ウェブトゥーン）翻訳をこのサイトで使う（切り替え）**：小説モード⇄WTモードの切り替え
- **本文エリアを手動で選ぶ**：本文以外まで訳されるとき
- **このサイトでボタンを常に表示**：ボタンが出ないとき
- **診断**：うまく動かないときに状態を確認

---

## 5. 訳をよくするコツ

設定の中で書けます。
- **用語集**：`原語=訳語` を1行に1つ書くと、その訳語で固定されます
- **追加の指示**：`主人公（男）の一人称は「俺」` のように書くと従います
- **作品メモ**：人物・一人称・口調を自動でまとめます。手で直してもOK

---

## 6. バックアップ（おすすめ）

訳の記録は端末の中に保存されます。端末を無くしたときのために、GitHubに自動で保存できます。

1. [GitHub](https://github.com/) のアカウントを作る（無料）
2. Settings → Developer settings → Personal access tokens → **Tokens (classic)** → Generate new token
3. 権限は **gist だけ** チェック、期限は No expiration
4. できたトークンを ⚙ の「GitHubのトークン」に貼って保存 → 「今すぐクラウドに保存」

新しい端末では、スクリプトを入れてトークンを貼り、「クラウドから戻す」を押せば戻ります。
APIキーとトークンはバックアップに入らないので、入れ直してください。

---

## 7. 料金の目安（Gemini Flash）

- 小説：1話 **数円くらい**
- WT：画像の量によって変わります（文字の多い話ほど高め）
- 同じ話を開き直したときは **0円**（保存済みの訳を表示）
- 使いすぎが心配なら、Googleの請求画面で上限を決めておくと安心です

---

## 注意

- 訳は **自分で読む用** です。訳文を人に配ったりネットに上げたりしないでください（悪用を防ぐため、訳文のコピー・HTML保存の機能は入っていません）
- APIキー・トークンは人に教えないでください
- サイトの作りが変わると動かなくなることがあります

## 困ったとき

- **ボタンが出ない** → メニューの「このサイトでボタンを常に表示」
- **原文が残る** → 自動で訳し直します。それでも残れば「この話を翻訳し直す」
- **「混雑中」と出る** → 少し待つと自動でやり直します
- **WTで吹き出しがずれる・訳されない** → WTの設定の「確認モード」をオンにして、スクショを作者に送ってください
- **それでもダメ** → メニューの「診断」の画面をスクショして作者に送ってください

---

## 作者を応援する

このスクリプトは無料で使えます。気に入ったら、ここから応援してもらえるとうれしいです☕

👉 **[OFUSEで応援する](https://ofuse.me/ikasumi)**

（スクリプトの設定画面のいちばん下にもボタンがあります）

---

## English

**Ikasumi Translator** translates Korean and Chinese web novels into natural English right on the page, using the whole chapter as context so names and tone stay consistent. It also translates speech bubbles in comics/webtoons (WT mode).

> The English version is currently a **beta**. Please report anything strange.

**Install**
1. Install **Tampermonkey** (Chrome / Edge / Firefox / Safari on iPhone) or **Violentmonkey** (Firefox, also on Android).
2. Open 👉 **[Install the script (beta)](https://raw.githubusercontent.com/ikazu23/novel-translator/main/korean-novel-translator.beta.user.js)** and press "Install".
3. Open a novel page and tap ⚙ to open settings. Choose **Language / 表示・翻訳の言語: English**, enter your **Gemini API key** ([get one at Google AI Studio](https://aistudio.google.com/apikey)) and press **Save**.
4. Press **TL** to translate, **RAW** to go back to the original.

**Works on:** Ridibooks, KakaoPage (novels & webtoons), Naver Webtoon, Jinjiang (晋江), and most novel sites.

**Notes**
- On a fresh install, the script starts in English unless your browser is set to Japanese or Chinese. You can switch any time in Settings.
- Your API key and records stay in your browser. Translations are saved, so reopening a chapter costs nothing.
- Translations are for personal use only. Copying or exporting translated text is not available.

☕ [Support the author (OFUSE)](https://ofuse.me/ikasumi)

---

## 中文

**イカ墨翻訳（Ikasumi Translator）** 能在网页上直接把韩国网络小说翻译成自然的简体中文。它会参考整章内容来翻译，人名和语气前后一致。还能翻译漫画、条漫的对话框（WT模式）。

> 中文版目前是**测试版**。如果发现奇怪的地方，欢迎反馈。

**安装方法**
1. 安装浏览器扩展 **Tampermonkey**（Chrome / Edge / Firefox / iPhone 的 Safari）或 **Violentmonkey**（Firefox，安卓也可用）。
2. 打开 👉 **[安装脚本（测试版）](https://raw.githubusercontent.com/ikazu23/novel-translator/main/korean-novel-translator.beta.user.js)**，点击“安装”。
3. 打开小说页面，点 ⚙ 打开设置。在 **语言 / Language** 中选择 **中文（简体）**，填入 **Gemini API 密钥**（可在 [Google AI Studio](https://aistudio.google.com/apikey) 获取），然后点 **保存**。
4. 按 **译** 开始翻译，按 **原** 恢复原文。

**支持的网站：** Ridibooks、KakaoPage（小说和条漫）、Naver Webtoon，以及大多数小说网站。

**说明**
- 首次安装时，如果浏览器语言是中文，会自动以中文界面启动。
- API 密钥和翻译记录只保存在你的浏览器里。翻译过的章节会被保存，再次打开不会产生费用。
- 译文仅供个人使用。本脚本不提供复制或导出译文的功能。

☕ [支持作者（OFUSE）](https://ofuse.me/ikasumi)

