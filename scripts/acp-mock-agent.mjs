#!/usr/bin/env node
/**
 * 最小 ACP Agent（mock），用于端到端验证客户端实现（派生自 spike 原型）。
 *
 * 只实现 ACP v1 的基线方法：
 *   initialize、session/new、session/prompt、session/cancel、
 *   session/update（通知）、session/request_permission（反向请求）
 * 以及被授权后对客户端 fs/read_text_file 的调用。
 *
 * 刻意模拟的边界：
 *   - 一条 session/update 分两次 write 输出，且切点落在中文字符的 UTF-8 字节中间；
 *   - 同一 messageId 的多个 agent_message_chunk；
 *   - tool_call -> request_permission -> tool_call_update 的顺序；
 *   - 允许/拒绝两条路径。
 */

import { createInterface } from 'node:readline'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const PROTOCOL_VERSION = 1
const sessions = new Map()
let nextSession = 0
let nextAgentRequestId = 1000
const pendingAgentRequests = new Map()
let activeTurn = null
let shuttingDown = false

function send(message) {
  if (shuttingDown) return
  try {
    process.stdout.write(`${JSON.stringify(message)}\n`)
  } catch (error) {
    if (error?.code !== 'EPIPE') throw error
  }
}

function sendUpdate(sessionId, update) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } })
}

function sendError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } })
}

function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function sleep(ms) {
  return new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms)
    timer.unref?.()
  })
}

/**
 * 故意把一行 JSON 从 UTF-8 多字节字符中间切开写两次。
 * 客户端若按 chunk 直接 toString('utf8') 就会得到替换字符 U+FFFD。
 */
async function writeLineSplitInsideMultibyte(line) {
  const bytes = Buffer.from(`${line}\n`, 'utf8')
  let splitAt = -1
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] >= 0xe0) {
      splitAt = i + 1 // 连续 3 字节字符的中间
      break
    }
  }
  if (splitAt <= 0 || splitAt >= bytes.length) {
    process.stdout.write(bytes)
    return
  }
  process.stdout.write(bytes.subarray(0, splitAt))
  await sleep(3)
  process.stdout.write(bytes.subarray(splitAt))
}

async function waitForCancellation(turn, timeoutMs = 30_000) {
  const startedAt = Date.now()
  while (!turn.cancelled && !shuttingDown && Date.now() - startedAt < timeoutMs) {
    await sleep(50)
  }
}

async function requestPermission(sessionId, toolCall, title) {
  return agentRequest('session/request_permission', {
    sessionId,
    toolCall: {
      toolCallId: toolCall.toolCallId,
      title,
      kind: toolCall.kind,
      status: 'pending',
      locations: toolCall.locations ?? [],
      rawInput: toolCall.rawInput ?? {}
    },
    options: [
      { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
      { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' }
    ]
  })
}

async function handleCoordinatorPrompt(id, turn, sessionId, promptText) {
  if (promptText.includes('[mock-hang-plan]')) {
    sendUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg_mock_coordinator_wait',
      content: { type: 'text', text: '协调器等待模拟取消。' }
    })
    await waitForCancellation(turn)
    finishTurn(id, turn, 'cancelled')
    return
  }

  const team = [...promptText.matchAll(/^- ([a-z0-9._-]+)$/gim)].map((match) => match[1])
  if (team.length < 2) throw new Error('协调器提示词未包含至少两个团队成员')
  const goal = promptText.match(/^用户目标：(.+)$/m)?.[1] ?? '完成集成测试任务'
  const plan = {
    summary: '实现可见文件并由不同 Agent 完成最终审查',
    steps: [
      {
        id: 'implement',
        title: '实现集成测试文件',
        role: 'implement',
        agentId: team[0],
        dependsOn: [],
        input: `实现用户目标：${goal}`,
        expectedOutput: '在当前 worktree 写入 coordinator-result.txt'
      },
      {
        id: 'review',
        title: '审查实现结果',
        role: 'review',
        agentId: team[1],
        dependsOn: ['implement'],
        input: '检查 coordinator-result.txt 并确认内容完整',
        expectedOutput: '明确给出审查结论'
      }
    ]
  }
  sendUpdate(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'msg_mock_coordinator_plan',
    content: { type: 'text', text: JSON.stringify(plan) }
  })
  finishTurn(id, turn, 'end_turn')
}

async function handleImplementationPrompt(id, turn, sessionId, promptText) {
  if (
    promptText.includes('[mock-hang-implement]') &&
    !promptText.includes('恢复未完成任务')
  ) {
    sendUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg_mock_implementation_wait',
      content: { type: 'text', text: '实现步骤等待模拟应用重启。' }
    })
    await waitForCancellation(turn)
    finishTurn(id, turn, 'cancelled')
    return
  }

  const targetPath = join(turn.cwd, 'coordinator-result.txt')
  const toolCall = {
    toolCallId: 'call_mock_coordinator_write',
    kind: 'edit',
    locations: [{ path: targetPath }],
    rawInput: { path: targetPath }
  }
  sendUpdate(sessionId, {
    sessionUpdate: 'tool_call',
    toolCallId: toolCall.toolCallId,
    title: `写入 ${targetPath}`,
    name: 'write_file',
    kind: toolCall.kind,
    status: 'pending',
    locations: toolCall.locations,
    rawInput: toolCall.rawInput
  })
  const permission = await requestPermission(sessionId, toolCall, `写入 ${targetPath}`)
  if (turn.cancelled) {
    finishTurn(id, turn, 'cancelled')
    return
  }
  const outcome = permission?.outcome
  const allowed = outcome?.outcome === 'selected' && outcome.optionId === 'allow-once'
  if (!allowed) {
    sendUpdate(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: toolCall.toolCallId,
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: '写入权限被拒绝。' } }]
    })
    sendUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg_mock_implementation',
      content: { type: 'text', text: '实现未执行：写入权限被拒绝。' }
    })
    finishTurn(id, turn, 'end_turn')
    return
  }

  const goal = promptText.match(/实现用户目标：(.+)$/m)?.[1] ?? '协作任务'
  await writeFile(targetPath, `阳鸽协作任务完成\n${goal}\n`, 'utf8')
  sendUpdate(sessionId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: toolCall.toolCallId,
    status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: '文件已写入。' } }]
  })
  sendUpdate(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'msg_mock_implementation',
    content: { type: 'text', text: '实现完成：已写入 coordinator-result.txt。' }
  })
  finishTurn(id, turn, 'end_turn')
}

async function handleReviewPrompt(id, turn, sessionId, promptText) {
  const targetPath = join(turn.cwd, 'coordinator-result.txt')
  let content = ''
  try {
    content = await readFile(targetPath, 'utf8')
  } catch (error) {
    sendUpdate(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg_mock_review',
      content: { type: 'text', text: `审查失败：${error.message}` }
    })
    finishTurn(id, turn, 'end_turn')
    return
  }
  sendUpdate(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    messageId: 'msg_mock_review',
    content: {
      type: 'text',
      text: `审查通过：coordinator-result.txt 可读，内容为 ${JSON.stringify(content)}`
    }
  })
  finishTurn(id, turn, 'end_turn')
}

function agentRequest(method, params, timeoutMs = 5000) {
  const id = nextAgentRequestId++
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pendingAgentRequests.delete(id)
      resolvePromise({ outcome: { outcome: 'cancelled' } })
    }, timeoutMs)
    timer.unref?.()
    pendingAgentRequests.set(id, {
      resolve: (result) => {
        clearTimeout(timer)
        pendingAgentRequests.delete(id)
        resolvePromise(result)
      },
      reject: (error) => {
        clearTimeout(timer)
        pendingAgentRequests.delete(id)
        rejectPromise(error)
      }
    })
    send({ jsonrpc: '2.0', id, method, params })
  })
}

async function handleInitialize(id, params) {
  if (!params || params.protocolVersion !== PROTOCOL_VERSION) {
    sendError(id, -32602, `仅支持 ACP protocolVersion=${PROTOCOL_VERSION}`)
    return
  }
  sendResult(id, {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false }
    },
    agentInfo: { name: 'mock-agent', title: 'YangGe Mock ACP Agent', version: '0.1.0' },
    authMethods: []
  })
}

function handleSessionNew(id, params) {
  if (!params || typeof params.cwd !== 'string' || !resolve(params.cwd)) {
    sendError(id, -32602, 'session/new 需要绝对路径 cwd')
    return
  }
  const sessionId = `sess_mock_${++nextSession}`
  sessions.set(sessionId, { cwd: resolve(params.cwd) })
  sendResult(id, { sessionId })
}

async function handlePrompt(id, params) {
  const session = sessions.get(params?.sessionId)
  if (!session) {
    sendError(id, -32002, `未知会话：${params?.sessionId}`, { sessionId: params?.sessionId })
    return
  }
  if (!Array.isArray(params.prompt) || params.prompt.length === 0) {
    sendError(id, -32602, 'session/prompt 需要非空 prompt')
    return
  }
  if (activeTurn) {
    sendError(id, -32600, 'mock agent 不支持同一连接并发 prompt')
    return
  }

  const turn = {
    sessionId: params.sessionId,
    cwd: session.cwd,
    cancelled: false,
    done: false
  }
  activeTurn = turn
  const promptText = params.prompt
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')

  try {
    // 测试用：让 prompt 长时间不返回，用于验证客户端关闭时挂起请求的清理。
    if (promptText.includes('[hang]')) {
      await waitForCancellation(turn)
      if (!turn.done) finishTurn(id, turn, 'cancelled')
      return
    }

    if (promptText.includes('你是阳鸽任务的协调者')) {
      await handleCoordinatorPrompt(id, turn, params.sessionId, promptText)
      return
    }
    if (promptText.includes('你是阳鸽编码团队中的 implement Agent')) {
      await handleImplementationPrompt(id, turn, params.sessionId, promptText)
      return
    }
    if (promptText.includes('你是阳鸽编码团队中的 review Agent')) {
      await handleReviewPrompt(id, turn, params.sessionId, promptText)
      return
    }

    // 1) 计划
    sendUpdate(params.sessionId, {
      sessionUpdate: 'plan',
      entries: [
        { content: '读取用户消息', priority: 'high', status: 'completed' },
        { content: '请求写入权限', priority: 'high', status: 'in_progress' },
        { content: '汇总结果', priority: 'medium', status: 'pending' }
      ]
    })
    await sleep(5)
    if (turn.cancelled) return finishTurn(id, turn, 'cancelled')

    // 2) 流式消息：第一条故意跨 UTF-8 字节边界
    const firstChunk = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'msg_agent_mock_1',
          content: { type: 'text', text: '你好，世界！这是 ACP 流式消息。' }
        }
      }
    }
    await writeLineSplitInsideMultibyte(JSON.stringify(firstChunk))
    await sleep(5)
    if (turn.cancelled) return finishTurn(id, turn, 'cancelled')

    sendUpdate(params.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'msg_agent_mock_1',
      content: { type: 'text', text: `收到提示：${promptText}` }
    })

    // 3) 工具调用 + 权限请求
    const toolCallId = 'call_mock_read_1'
    const targetPath = join(session.cwd, 'sample.txt')
    sendUpdate(params.sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: `读取 ${targetPath}`,
      name: 'read_file',
      kind: 'read',
      status: 'pending',
      locations: [{ path: targetPath }],
      rawInput: { path: targetPath }
    })
    await sleep(5)

    const permission = await agentRequest('session/request_permission', {
      sessionId: params.sessionId,
      toolCall: {
        toolCallId,
        title: `读取 ${targetPath}`,
        kind: 'read',
        status: 'pending',
        locations: [{ path: targetPath }]
      },
      options: [
        { optionId: 'allow-once', name: '允许一次', kind: 'allow_once' },
        { optionId: 'reject-once', name: '拒绝', kind: 'reject_once' }
      ]
    })

    if (turn.cancelled) return finishTurn(id, turn, 'cancelled')

    const outcome = permission?.outcome
    const allowed = outcome?.outcome === 'selected' && outcome.optionId === 'allow-once'

    if (allowed) {
      sendUpdate(params.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'in_progress',
        content: [{ type: 'content', content: { type: 'text', text: '已获授权，开始读取…' } }]
      })

      let readBack = ''
      try {
        // 生产客户端只声明 fs.readTextFile，因此这里只读，验证能力与 root set。
        const read = await agentRequest('fs/read_text_file', {
          sessionId: params.sessionId,
          path: targetPath
        })
        readBack = read?.content ?? ''
      } catch (error) {
        sendUpdate(params.sessionId, {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'failed',
          content: [{ type: 'content', content: { type: 'text', text: `文件操作失败：${error.message}` } }]
        })
        return finishTurn(id, turn, 'end_turn')
      }

      sendUpdate(params.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        content: [{
          type: 'content',
          content: { type: 'text', text: `已读取 ${targetPath}：${JSON.stringify(readBack)}` }
        }],
        rawOutput: { path: targetPath, bytes: Buffer.byteLength(readBack, 'utf8') }
      })

      sendUpdate(params.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg_agent_mock_2',
        content: { type: 'text', text: '已完成：文件已读取。' }
      })
    } else {
      sendUpdate(params.sessionId, {
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: '用户拒绝授权，未读取文件。' } }]
      })
      sendUpdate(params.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'msg_agent_mock_2',
        content: { type: 'text', text: '已拒绝读取，未访问文件。' }
      })
    }

    finishTurn(id, turn, 'end_turn')
  } catch (error) {
    if (!turn.done) {
      turn.done = true
      activeTurn = null
      sendError(id, -32603, `mock agent 内部错误：${error.message}`)
    }
  }
}

function finishTurn(id, turn, stopReason) {
  if (turn.done) return
  turn.done = true
  if (activeTurn === turn) activeTurn = null
  // 取消时按 ACP 要求，prompt 仍以 stopReason:"cancelled" 正常结束。
  sendResult(id, { stopReason })
}

function handleCancel(params) {
  if (!activeTurn) return
  if (params?.sessionId && activeTurn.sessionId !== params.sessionId) return
  activeTurn.cancelled = true
  // 客户端在取消时会以 cancelled 结束挂起的权限请求；这里也主动收口。
  for (const entry of pendingAgentRequests.values()) {
    entry.resolve({ outcome: { outcome: 'cancelled' } })
  }
}

function handleResponse(message) {
  const entry = pendingAgentRequests.get(message.id)
  if (!entry) return
  if (message.error) {
    entry.reject(new Error(message.error.message ?? 'client error'))
  } else {
    entry.resolve(message.result)
  }
}

function handleRequest(message) {
  switch (message.method) {
    case 'initialize':
      void handleInitialize(message.id, message.params)
      break
    case 'session/new':
      handleSessionNew(message.id, message.params)
      break
    case 'session/prompt':
      void handlePrompt(message.id, message.params)
      break
    case 'session/load':
    case 'session/resume':
    case 'session/close':
      sendError(message.id, -32601, `mock agent 不实现 ${message.method}`)
      break
    default:
      sendError(message.id, -32601, `mock agent 未实现方法：${message.method}`)
  }
}

function handleLine(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    sendError(null, -32700, 'Parse error')
    return
  }
  if (message && message.method === 'session/cancel') {
    handleCancel(message.params)
    return
  }
  if (message && message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    handleResponse(message)
    return
  }
  if (message && typeof message.method === 'string' && message.id !== undefined) {
    handleRequest(message)
    return
  }
  sendError(message?.id ?? null, -32600, 'Invalid Request')
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', handleLine)
rl.on('close', () => {
  shuttingDown = true
  activeTurn = null
  process.exit(0)
})

process.on('uncaughtException', (error) => {
  try {
    process.stderr.write(`[mock-agent] uncaught: ${error?.stack ?? error}\n`)
  } catch {
    // ignore
  }
  process.exit(1)
})
