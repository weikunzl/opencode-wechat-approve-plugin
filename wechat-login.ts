import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import qrterm from "qrcode-terminal"

const ILINK_BASE = "https://ilinkai.weixin.qq.com"
const BOT_TYPE = "3"
const WECHAT_DIR = path.join(process.env.HOME || "~", ".opencode", "wechat")

fs.mkdirSync(WECHAT_DIR, { recursive: true })

async function main() {
  console.log("\n🔗 微信 OpenCode 插件登录工具\n")
  console.log("正在获取二维码...\n")

  const qrResp = (await fetch(
    `${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`
  ).then((r) => r.json())) as { qrcode: string; qrcode_img_content: string }

  console.log("📎 扫码链接（可复制到浏览器打开）:")
  console.log(`   ${qrResp.qrcode_img_content}\n`)
  console.log("📱 请使用微信扫描以下二维码：\n")

  qrterm.generate(qrResp.qrcode_img_content, { small: true }, (qr: string) => {
    console.log(qr)
  })

  console.log("\n⏳ 等待扫码（8分钟超时）...\n")

  const deadline = Date.now() + 480_000
  let scannedPrinted = false

  while (Date.now() < deadline) {
    const status = (await fetch(
      `${ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrResp.qrcode)}`
    ).then((r) => r.json())) as {
      status: "wait" | "scaned" | "confirmed" | "expired"
      bot_token?: string
      ilink_bot_id?: string
      baseurl?: string
      ilink_user_id?: string
    }

    switch (status.status) {
      case "wait":
        break
      case "scaned":
        if (!scannedPrinted) {
          console.log("✅ 已扫码，请在微信中点击确认...")
          scannedPrinted = true
        }
        break
      case "expired":
        console.log("❌ 二维码已过期，请重新运行脚本。")
        process.exit(1)
      case "confirmed": {
        if (!status.ilink_bot_id || !status.bot_token) {
          console.error("❌ 登录确认但未返回 bot 信息")
          process.exit(1)
        }
        const account = {
          token: status.bot_token,
          baseUrl: status.baseurl || ILINK_BASE,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          savedAt: new Date().toISOString(),
        }
        const accountFile = path.join(WECHAT_DIR, "account.json")
        fs.writeFileSync(accountFile, JSON.stringify(account, null, 2), "utf-8")
        fs.chmodSync(accountFile, 0o600)

        console.log(`\n🎉 微信连接成功！`)
        console.log(`   账号ID: ${account.accountId}`)
        console.log(`   凭据已保存到: ${accountFile}`)
        console.log(`\n现在可以启动 opencode web 使用微信插件了。\n`)
        process.exit(0)
      }
    }
    await new Promise((r) => setTimeout(r, 1500))
  }

  console.log("❌ 登录超时，请重新运行脚本。")
  process.exit(1)
}

main().catch((err) => {
  console.error("登录失败:", err)
  process.exit(1)
})
