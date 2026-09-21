import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDocumentFile,
  documentFileFilter,
  isAllowedExtension,
} from '../../src/services/documentParser.js'

/** 构造一个 multer 风格的内存文件对象 */
function uploadFile(name, content, mimetype = 'text/plain') {
  return {
    originalname: name,
    mimetype,
    buffer: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8'),
    size: Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content),
  }
}

/* ---------- 最小 stored ZIP 构造器（用于生成合法 docx） ---------- */

function crc32(buf) {
  let table = crc32.table
  if (!table) {
    table = crc32.table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function buildZip(files) {
  const chunks = []
  const central = []
  let offset = 0
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 文件名标志
    local.writeUInt16LE(0, 8) // 0 = stored 不压缩
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    chunks.push(local, nameBuf, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([cd, nameBuf]))
    offset += local.length + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, centralBuf, eocd])
}

/** 构造一个包含指定段落文本的最小合法 docx */
function minimalDocx(paragraphs) {
  const body = paragraphs
    .map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`)
    .join('')
  return buildZip([
    {
      name: '[Content_Types].xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      ),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
    },
    {
      name: 'word/document.xml',
      data: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
      ),
    },
  ])
}

/* ---------- 正常解析 ---------- */

test('Markdown 解析：一级标题作为标题，正文保留', async () => {
  const file = uploadFile('guide.md', '# 新员工入职指南\n\n## 第一天\n\n准备材料到行政部报到。')
  const result = await parseDocumentFile(file)
  assert.equal(result.format, 'markdown')
  assert.equal(result.title, '新员工入职指南')
  assert.match(result.content, /准备材料到行政部报到/)
})

test('Markdown 无 H1 时取首个非空行作为标题', async () => {
  const file = uploadFile('notes.markdown', '随手笔记第一行\n\n正文内容')
  const result = await parseDocumentFile(file)
  assert.equal(result.title, '随手笔记第一行')
})

test('TXT 解析：去 BOM、统一换行、首行作为标题', async () => {
  const file = uploadFile('note.txt', '\uFEFF报销说明\r\n第二条内容\r\n')
  const result = await parseDocumentFile(file)
  assert.equal(result.format, 'text')
  assert.equal(result.title, '报销说明')
  assert.ok(result.content.includes('报销说明\n第二条内容'))
  assert.ok(!result.content.includes('\r'))
})

test('DOCX 解析：提取纯文本段落', async () => {
  const docx = minimalDocx(['DOCX测试正文第一段', '第二段内容'])
  const file = uploadFile('word.docx', docx, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  const result = await parseDocumentFile(file)
  assert.equal(result.format, 'docx')
  assert.match(result.content, /DOCX测试正文第一段/)
  assert.match(result.content, /第二段内容/)
  assert.equal(result.title, 'DOCX测试正文第一段')
})

/* ---------- 安全校验与拒绝路径 ---------- */

test('非法扩展名直接拒绝（.pdf / .doc / 无扩展名）', async () => {
  assert.equal(isAllowedExtension('a.pdf'), false)
  for (const name of ['a.pdf', 'a.doc', 'a']) {
    await assert.rejects(() => parseDocumentFile(uploadFile(name, 'x')), { status: 400 })
  }
})

test('文本文件夹带 NUL 字节（二进制伪装）被拒绝', async () => {
  const fake = Buffer.concat([Buffer.from('MZ\x00\x00二进制伪装', 'utf-8')])
  await assert.rejects(() => parseDocumentFile(uploadFile('evil.txt', fake)), { status: 400 })
})

test('ZIP 内容伪装成 txt 被拒绝；docx 却不是 ZIP 也拒绝', async () => {
  const zipHead = Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Buffer.from('fake')])
  await assert.rejects(() => parseDocumentFile(uploadFile('evil.txt', zipHead)), { status: 400 })
  await assert.rejects(() => parseDocumentFile(uploadFile('evil.docx', Buffer.from('not a zip'))), {
    status: 400,
  })
})

test('空白内容与空 buffer 被拒绝', async () => {
  await assert.rejects(() => parseDocumentFile(uploadFile('empty.txt', '   \n\t\n ')), {
    status: 400,
  })
  await assert.rejects(() => parseDocumentFile({ originalname: 'a.txt', buffer: null }), {
    status: 400,
  })
})

test('multer fileFilter：扩展名与明显不符的 MIME 被拦', async () => {
  const filterResult = (file) =>
    new Promise((resolve, reject) =>
      documentFileFilter({}, file, (err, ok) => (err ? reject(err) : resolve(ok))),
    )
  await assert.rejects(
    filterResult({ originalname: 'a.exe', mimetype: 'application/x-msdownload' }),
    { status: 400 },
  )
  await assert.rejects(filterResult({ originalname: 'a.png', mimetype: 'image/png' }), {
    status: 400,
  })
  // md 的 MIME 在不同环境不统一，octet-stream / text/plain / 空都应放行
  for (const mime of ['text/plain', 'application/octet-stream', '']) {
    assert.equal(await filterResult({ originalname: 'a.md', mimetype: mime }), true)
  }
})
