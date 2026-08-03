import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import qrcode from "qrcode"
import {
  REBIND_PAGE_NAME_PATTERN,
  RebindStatus,
  type RebindState,
} from "./rebind-state.js"

enum RebindPageMode {
  Directory = 0o700,
  File = 0o600,
}

const REBIND_PAGE_DIRECTORY = "rebind-pages"

export interface RebindPageDescriptor {
  fileName: string
  filePath: string
  url: string
  expiresAt: number
}

interface RebindPageStoreOptions {
  directory: string
  now?: () => number
  randomID?: () => string
  renderQRCode?: (value: string) => Promise<string>
}

export class RebindPageStore {
  private readonly directory: string
  private readonly now: () => number
  private readonly randomID: () => string
  private readonly renderQRCode: (value: string) => Promise<string>

  constructor(options: RebindPageStoreOptions) {
    // 页面与普通状态隔离，便于启动和退出时精确清理。
    this.directory = path.join(options.directory, REBIND_PAGE_DIRECTORY)
    this.now = options.now ?? Date.now
    this.randomID = options.randomID ?? (() => crypto.randomBytes(16).toString("hex"))
    this.renderQRCode = options.renderQRCode ?? renderQRCode
  }

  async create(input: { qrContent: string; expiresAt: number }): Promise<RebindPageDescriptor> {
    // 二维码先在内存渲染，原始内容不单独落盘。
    if (input.expiresAt <= this.now()) throw new Error("微信二维码已过期")
    const fileName = `wechat-rebind-${this.randomID()}.html`
    if (!REBIND_PAGE_NAME_PATTERN.test(fileName)) throw new Error("微信二维码页面标识无效")
    const svg = await this.renderQRCode(input.qrContent)
    return this.writePage({ fileName, svg, expiresAt: input.expiresAt })
  }

  resolveLink(state: RebindState): RebindPageDescriptor | null {
    // CLI 只返回仍有效且真实存在的受控页面。
    if (!pageIsActive(state, this.now())) return null
    const filePath = this.pagePath(state.pageFileName!)
    if (!fs.existsSync(filePath)) return null
    return descriptor(state.pageFileName!, filePath, state.expiresAt!)
  }

  removeCurrent(state: RebindState): void {
    // 只删除通过白名单校验的当前页面，不接受任意路径。
    if (!state.pageFileName || !REBIND_PAGE_NAME_PATTERN.test(state.pageFileName)) return
    this.removeFile(this.pagePath(state.pageFileName))
  }

  cleanupAll(): void {
    // 启动时清理旧进程遗留页面，目录外文件永不触碰。
    if (!fs.existsSync(this.directory)) return
    for (const name of fs.readdirSync(this.directory)) {
      if (REBIND_PAGE_NAME_PATTERN.test(name)) this.removeFile(this.pagePath(name))
    }
  }

  private writePage(input: { fileName: string; svg: string; expiresAt: number }): RebindPageDescriptor {
    // 写入后再次收紧权限，兼容受 umask 影响的平台。
    fs.mkdirSync(this.directory, { recursive: true, mode: RebindPageMode.Directory })
    fs.chmodSync(this.directory, RebindPageMode.Directory)
    const filePath = this.pagePath(input.fileName)
    fs.writeFileSync(filePath, renderPage(input.svg, input.expiresAt), { mode: RebindPageMode.File })
    fs.chmodSync(filePath, RebindPageMode.File)
    return descriptor(input.fileName, filePath, input.expiresAt)
  }

  private pagePath(fileName: string): string {
    return path.join(this.directory, fileName)
  }

  private removeFile(file: string): void {
    try {
      fs.unlinkSync(file)
    } catch {}
  }
}

async function renderQRCode(value: string): Promise<string> {
  return qrcode.toString(value, { type: "svg", errorCorrectionLevel: "M", margin: 2 })
}

function descriptor(fileName: string, filePath: string, expiresAt: number): RebindPageDescriptor {
  return { fileName, filePath, url: pathToFileURL(filePath).href, expiresAt }
}

function pageIsActive(state: RebindState, now: number): boolean {
  return [RebindStatus.QrReady, RebindStatus.Confirming].includes(state.status) &&
    state.expiresAt !== null && state.expiresAt > now && state.pageFileName !== null
}

function renderPage(svg: string, expiresAt: number): string {
  // 页面完全离线，不引入脚本、外链图片或远程字体。
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">` +
    `<title>重新绑定微信</title><body><main><h1>重新绑定微信</h1>${svg}` +
    `<p>请使用微信扫码确认，然后在目标私聊中发送“绑定”。</p>` +
    `<p>二维码过期时间：${new Date(expiresAt).toISOString()}</p>` +
    `<p>绑定完成后可以关闭此页面。</p></main></body></html>`
}
