import { type FormEvent, useEffect, useMemo, useState } from 'react'
import './App.css'

type ServerStatus = 'online' | 'warning' | 'offline'

type InstanceMetric = {
  id: string
  name: string
  status: ServerStatus
  running: boolean
  uptime: number
  cpu: number
  memory: number
  players: number
  maxPlayers: number
  imageUrl: string
  connection: string
  activeUsers: number
}

type ServerConfig = {
  baseUrl: string
  username: string
  password: string
}

type LogLevel = 'info' | 'success' | 'warning' | 'error'

type LogEntry = {
  id: number
  timestamp: number
  level: LogLevel
  text: string
}

const STORAGE_KEY = 'amp-dashboard-config-v1'
const SESSION_STORAGE_KEY = 'amp-dashboard-session-v1'
const defaultConfig: ServerConfig = {
  baseUrl: '',
  username: '',
  password: '',
}

const normalizeBaseUrl = (baseUrl: string) => {
  const trimmedBaseUrl = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmedBaseUrl || /^[a-z][a-z\d+.-]*:\/\//i.test(trimmedBaseUrl)) {
    return trimmedBaseUrl
  }

  return `http://${trimmedBaseUrl}`
}
const buildAmpUrl = (baseUrl: string, path: string) => {
  const normalizedBase = normalizeBaseUrl(baseUrl)
  if (!normalizedBase) {
    return path
  }

  if (typeof window !== 'undefined' && import.meta.env.VITE_AMP_PROXY_TARGET) {
    try {
      const targetUrl = new URL(normalizedBase)
      if (targetUrl.origin !== window.location.origin) {
        return `/amp-api${path.startsWith('/') ? path : `/${path}`}`
      }
    } catch {
      // Fall through to direct URL handling.
    }
  }

  return `${normalizedBase}${path.startsWith('/') ? path : `/${path}`}`
}

const toNumber = (value: unknown, fallback = 0) => {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

const formatDurationSeconds = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '0d 00:00:00'
  }

  const totalSeconds = Math.floor(seconds)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const secs = totalSeconds % 60

  return `${days}d ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

const formatLogTimestamp = (timestamp: number) => new Date(timestamp).toLocaleTimeString([], {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

const parseAmpDuration = (value: unknown): { seconds: number; label: string } => {
  const raw = String(value ?? '').trim()
  if (!raw) {
    return { seconds: 0, label: 'N/A' }
  }

  const cleaned = raw.replace(/^Running Uptime:\s*/i, '').replace(/\s+/g, ' ').trim()
  if (!cleaned) {
    return { seconds: 0, label: 'N/A' }
  }

  const numeric = Number(cleaned)
  if (Number.isFinite(numeric) && numeric > 0) {
    return { seconds: numeric, label: formatDurationSeconds(numeric) }
  }

  const dayMatch = cleaned.match(/^(\d+):(\d{1,2}):(\d{1,2}):(\d{1,2})$/)
  if (dayMatch) {
    const [, days, hours, minutes, seconds] = dayMatch
    const totalSeconds = Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
    return { seconds: totalSeconds, label: formatDurationSeconds(totalSeconds) }
  }

  const hmsMatch = cleaned.match(/^(\d+):(\d{1,2}):(\d{1,2})$/)
  if (hmsMatch) {
    const [, hours, minutes, seconds] = hmsMatch
    const totalSeconds = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
    return { seconds: totalSeconds, label: formatDurationSeconds(totalSeconds) }
  }

  const wordMatch = cleaned.match(/(\d+)\s*day[s]?\s*(\d{1,2}):(\d{1,2}):(\d{1,2})/i)
  if (wordMatch) {
    const [, days, hours, minutes, seconds] = wordMatch
    const totalSeconds = Number(days) * 86400 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
    return { seconds: totalSeconds, label: formatDurationSeconds(totalSeconds) }
  }

  return { seconds: 0, label: cleaned }
}

const summarizePayload = (value: unknown) => {
  if (!value) {
    return 'empty'
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return 'array(0)'
    }

    const first = value[0]
    if (first && typeof first === 'object') {
      const keys = Object.keys(first as Record<string, unknown>)
      return `array(${value.length})[${keys.slice(0, 12).join(', ')}]`
    }

    return `array(${value.length})`
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const title = String(record.Title ?? record.title ?? '').trim()
    const message = String(record.Message ?? record.message ?? '').trim()
    if (title || message) {
      return [title, message].filter(Boolean).join(': ')
    }

    const keys = Object.keys(record)
    return keys.length > 0 ? `object(${keys.slice(0, 12).join(', ')})` : 'object(empty)'
  }

  return typeof value
}

const isAmpErrorPayload = (value: unknown) => {
  if (!value || typeof value !== 'object') {
    return false
  }

  const record = value as Record<string, unknown>
  return Boolean(record.Title || record.title || record.Error || record.error || record.StackTrace || record.stackTrace)
}

const debugAmp = (stage: string, payload: unknown, level: 'log' | 'info' | 'warn' | 'error' = 'log') => {
  if (typeof console !== 'undefined') {
    console[level](`[AMP] ${stage}`, payload)
  }
}

const parseSessionToken = (headerValue: string | null, payload: any): string => {
  if (headerValue?.startsWith('Bearer ')) {
    return headerValue.replace(/^Bearer\s+/i, '').trim()
  }

  if (!payload || typeof payload !== 'object') {
    return ''
  }

  for (const key of ['sessionID', 'SessionID', 'sessionId', 'SessionId', 'rememberMeToken', 'RememberMeToken', 'token', 'Token']) {
    const value = payload[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return ''
}

const fetchAmpJson = async (
  baseUrl: string,
  endpoint: string,
  sessionId: string,
  payload: Record<string, unknown> = {},
  signal?: AbortSignal,
  onLog?: (message: string, level?: LogLevel) => void,
) => {
  const url = buildAmpUrl(baseUrl, `/API/${endpoint}`)
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'AMP-Dashboard/1.0',
  }

  if (sessionId) {
    headers.Authorization = `Bearer ${sessionId}`
  }

  const requestBody = {
    ...payload,
    ...(sessionId ? { SESSIONID: sessionId } : {}),
    parameters: payload,
  }

  debugAmp('request', { endpoint, url, sessionId, payload: requestBody }, 'info')
  onLog?.(`Request -> ${endpoint} @ ${url}`, 'info')

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify(requestBody),
    })

    const rawText = await response.text()
    let json: any = null

    try {
      json = rawText ? JSON.parse(rawText) : null
    } catch {
      json = null
    }

    const authHeader = response.headers.get('authorization') ?? response.headers.get('Authorization') ?? null
    const extractedSession = parseSessionToken(authHeader, json) || sessionId
    const summary = summarizePayload(json)
    const responseHasError = !response.ok || isAmpErrorPayload(json)
    debugAmp('response', { endpoint, status: response.status, ok: response.ok, summary, body: json }, responseHasError ? 'warn' : 'info')
    onLog?.(`Response <- ${endpoint} (${response.status}) ${summary}`, responseHasError ? 'warning' : 'success')

    return {
      response,
      payload: json,
      sessionId: extractedSession,
      error: null as string | null,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown AMP request error.'
    debugAmp('fetch-error', { endpoint, url, error: message }, 'error')
    onLog?.(`Request failed for ${endpoint}: ${message}`, 'error')
    return {
      response: null,
      payload: { error: message },
      sessionId: '',
      error: message,
    }
  }
}

const findDeepValue = (value: unknown, keys: string[], seen = new Set<object>()): unknown => {
  if (!value || typeof value !== 'object') {
    return undefined
  }

  if (seen.has(value as object)) {
    return undefined
  }
  seen.add(value as object)

  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findDeepValue(entry, keys, seen)
      if (nested !== undefined) {
        return nested
      }
    }
    return undefined
  }

  const record = value as Record<string, unknown>

  for (const key of keys) {
    const direct = record[key]
    if (direct !== undefined) {
      return direct
    }

    for (const candidate of Object.keys(record)) {
      if (candidate.toLowerCase() === key.toLowerCase()) {
        return record[candidate]
      }
    }
  }

  for (const nested of Object.values(record)) {
    const found = findDeepValue(nested, keys, seen)
    if (found !== undefined) {
      return found
    }
  }

  return undefined
}

const getMetricEntry = (item: Record<string, unknown>, metricName: string) => {
  const metrics = findDeepValue(item, ['Metrics']) as Record<string, unknown> | undefined
  if (!metrics || typeof metrics !== 'object') {
    return undefined
  }

  const exactKey = Object.keys(metrics).find((key) => key.toLowerCase() === metricName.toLowerCase())
  if (exactKey) {
    return metrics[exactKey] as Record<string, unknown> | undefined
  }

  const normalizedKey = metricName.toLowerCase().replace(/\s+/g, '')
  for (const [key, value] of Object.entries(metrics)) {
    if (key.toLowerCase().replace(/\s+/g, '') === normalizedKey && value && typeof value === 'object') {
      return value as Record<string, unknown>
    }
  }

  return undefined
}

const isLikelyApiSpecNode = (entry: Record<string, unknown>) => {
  const keys = Object.keys(entry).map((key) => key.toLowerCase())
  const hasSchemaMarkers = keys.some((key) => ['parameters', 'returntypename', 'paramenumvalues', 'requiredpermissions', 'suffix', 'typename', 'parameternames', 'isoptional'].includes(key))
  const hasDescriptionOnly = keys.includes('description') && !hasSchemaMarkers
  return hasSchemaMarkers || (hasDescriptionOnly && Object.keys(entry).length <= 6)
}

const hasInstanceIdentity = (entry: Record<string, unknown>) => {
  const keys = Object.keys(entry).map((key) => key.toLowerCase())
  return keys.some((key) => ['id', 'instanceid', 'name', 'friendlyname', 'displayname', 'instancename', 'title', 'hostname', 'port', 'instance', 'appname', 'modulename'].includes(key))
}

const isLikelyInstanceEntry = (entry: Record<string, unknown>) => {
  const keys = Object.keys(entry).map((key) => key.toLowerCase())
  if (isLikelyApiSpecNode(entry)) {
    return false
  }

  const isAdsWrapper = keys.some((key) => ['availableinstances', 'availableips', 'cancreate', 'createsincontainers', 'datastores', 'isremote', 'fitness', 'disabled'].includes(key))
  if (isAdsWrapper) {
    return false
  }

  const hasIdentity = hasInstanceIdentity(entry)
  const hasLifecycle = keys.some((key) => ['state', 'status', 'running', 'isrunning', 'online', 'isonline', 'uptime', 'players', 'maxplayers', 'cpu', 'memory', 'metrics', 'disk', 'ram'].includes(key))
  const hasServerFields = keys.some((key) => ['module', 'modulename', 'appname', 'filepath', 'workingdirectory', 'displayimageuri', 'imageuri', 'icon'].includes(key))

  return hasIdentity || hasLifecycle || hasServerFields
}

const unwrapAmpInstanceArray = (payload: any): Record<string, unknown>[] => {
  if (!payload) {
    return []
  }

  const queue: any[] = Array.isArray(payload) ? [...payload] : [payload]
  const seen = new Set<object>()

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== 'object' || seen.has(current)) {
      continue
    }
    seen.add(current)

    if (Array.isArray(current)) {
      queue.push(...current)
      continue
    }

    const record = current as Record<string, unknown>
    for (const key of ['AvailableInstances', 'Instances', 'items', 'Items', 'Result', 'Data', 'Apps', 'Servers']) {
      const direct = record[key] ?? record[key.toLowerCase()]
      if (Array.isArray(direct) && direct.length > 0) {
        const filtered = direct.filter((entry) => entry && typeof entry === 'object') as Record<string, unknown>[]
        if (filtered.length > 0) {
          return filtered
        }
      }
    }

    for (const nested of Object.values(record)) {
      if (nested && typeof nested === 'object') {
        queue.push(nested)
      }
    }
  }

  return []
}

const extractInstanceList = (payload: any): Record<string, unknown>[] => {
  const directList = unwrapAmpInstanceArray(payload)
  if (directList.length > 0) {
    return directList.filter((entry) => entry && typeof entry === 'object' && isLikelyInstanceEntry(entry as Record<string, unknown>)) as Record<string, unknown>[]
  }

  if (!payload) {
    return []
  }

  const queue: any[] = Array.isArray(payload) ? [...payload] : [payload]
  const seen = new Set<object>()

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || typeof current !== 'object' || seen.has(current)) {
      continue
    }
    seen.add(current)

    if (Array.isArray(current)) {
      queue.push(...current)
      continue
    }

    const record = current as Record<string, unknown>
    for (const key of ['AvailableInstances', 'Instances', 'items', 'Items', 'Result', 'Data', 'Apps', 'Servers']) {
      const direct = record[key] ?? record[key.toLowerCase()]
      if (Array.isArray(direct)) {
        const filtered = direct.filter((entry) => entry && typeof entry === 'object' && isLikelyInstanceEntry(entry as Record<string, unknown>)) as Record<string, unknown>[]
        if (filtered.length > 0) {
          return filtered
        }
        queue.push(...direct)
      }
    }

    for (const nested of Object.values(record)) {
      if (nested && typeof nested === 'object') {
        queue.push(nested)
      }
    }
  }

  return []
}

const parseSteamHeaderImage = (value: unknown) => {
  if (typeof value !== 'string' || !value.trim()) {
    return ''
  }

  const trimmed = value.trim()
  const steamMatch = trimmed.match(/steam:(\d+)/i) ?? trimmed.match(/apps\/(\d+)/i)
  if (steamMatch?.[1]) {
    return `https://cdn.cloudflare.steamstatic.com/steam/apps/${steamMatch[1]}/header.jpg`
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed
  }

  return ''
}

const getTwoFactorStatus = (payload: any): boolean => {
  if (!payload || typeof payload !== 'object') {
    return false
  }

  const code = payload.Code ?? payload.code ?? payload.Result ?? payload.result ?? payload.StatusCode ?? payload.statusCode
  const reason = String(payload.Reason ?? payload.reason ?? payload.Message ?? payload.message ?? '').toLowerCase()
  const state = String(payload.State ?? payload.state ?? '').toLowerCase()

  return Boolean(
    payload.RequiresTwoFactor ||
    payload.NeedsTwoFactor ||
    payload.TwoFactorRequired ||
    payload.TwoFactorChallenge ||
    state.includes('twofactor') ||
    state.includes('2fa') ||
    code === 40 ||
    code === 45 ||
    reason.includes('two-factor') ||
    reason.includes('2fa') ||
    reason.includes('authenticator') ||
    reason.includes('totp')
  )
}

const normalizeInstanceMetric = (item: Record<string, unknown>, index: number): InstanceMetric => {
  const identifier = String(findDeepValue(item, ['Id', 'id', 'InstanceID', 'InstanceId', 'Identifier']) ?? findDeepValue(item, ['Name', 'name', 'FriendlyName', 'DisplayName', 'InstanceName']) ?? `instance-${index + 1}`)
  const name = String(findDeepValue(item, ['Name', 'name', 'FriendlyName', 'DisplayName', 'InstanceName']) ?? `Instance ${index + 1}`)
  const rawState = String(findDeepValue(item, ['State', 'state', 'Status', 'status', 'RunningState', 'AppState']) ?? 'offline')
  const rawRunning = findDeepValue(item, ['Running', 'running', 'IsRunning', 'isRunning', 'Online', 'IsOnline'])
  const appState = toNumber(findDeepValue(item, ['AppState', 'appState']), 0)
  const running = Boolean(rawRunning === true || rawRunning === 'true' || rawRunning === 'True' || rawRunning === 'running' || rawRunning === 'Running' || appState === 20 || rawState === 'Running' || rawState === 'running' || rawState === '20')

  const cpuMetric = getMetricEntry(item, 'CPU Usage')
  const memoryMetric = getMetricEntry(item, 'Memory Usage')
  const usersMetric = getMetricEntry(item, 'Active Users')
  const endpoints = findDeepValue(item, ['ApplicationEndpoints']) as Array<Record<string, unknown>> | undefined
  const connection = String(endpoints?.[0]?.Endpoint ?? findDeepValue(item, ['Connection', 'Address', 'Endpoint', 'Host']) ?? '').replace(/^https?:\/\//i, '').replace(/\/$/, '')

  const cpuValue = cpuMetric ? (cpuMetric.RawValue ?? cpuMetric.Percent ?? cpuMetric.Value) : findDeepValue(item, ['CPU', 'Cpu', 'CPUUsage', 'CpuUsage', 'ProcessorUsage', 'CpuLoad', 'CPUPercent'])
  const memoryPercent = memoryMetric ? (memoryMetric.Percent ?? memoryMetric.UsagePercent ?? memoryMetric.Value) : findDeepValue(item, ['MemoryPercent', 'memoryPercent', 'RAMPercent', 'ramPercent', 'PercentUsed'])
  const memoryUsed = memoryMetric ? (memoryMetric.Used ?? memoryMetric.Current ?? memoryMetric.RawValue ?? memoryMetric.Value) : findDeepValue(item, ['MemoryUsed', 'memoryUsed', 'RAMUsed', 'ramUsed'])
  const memoryTotal = memoryMetric ? (memoryMetric.Total ?? memoryMetric.Max ?? memoryMetric.MaxValue) : findDeepValue(item, ['MemoryTotal', 'memoryTotal', 'RAMTotal', 'ramTotal'])
  const playersValue = usersMetric ? (usersMetric.RawValue ?? usersMetric.Value) : findDeepValue(item, ['PlayerCount', 'Players', 'CurrentPlayers', 'ConnectedPlayers', 'UserCount'])
  const maxPlayersValue = usersMetric ? (usersMetric.MaxValue ?? usersMetric.Total ?? usersMetric.Value) : findDeepValue(item, ['MaxPlayers', 'PlayerLimit', 'MaxPlayersAllowed'])
  const imageDisplay = findDeepValue(item, ['DisplayImageSource', 'DisplayImageURI', 'DisplayImage', 'ImageURI', 'ImageUrl', 'Image', 'ImageURL', 'BackgroundImage'])
  const imageUrl = parseSteamHeaderImage(imageDisplay) || String(imageDisplay ?? '')
  const uptimeInfo = parseAmpDuration(findDeepValue(item, ['Uptime', 'UptimeSeconds', 'UpTime', 'UpTimeSeconds', 'TimeRunning']))

  let memory = toNumber(memoryPercent, 0)
  if ((!memoryPercent || Number(memoryPercent) === 0) && memoryUsed && memoryTotal) {
    memory = Math.min(100, Math.round((toNumber(memoryUsed, 0) / toNumber(memoryTotal, 0)) * 100))
  }

  return {
    id: identifier,
    name,
    status: running ? 'online' : 'offline',
    running,
    uptime: uptimeInfo.seconds,
    cpu: toNumber(cpuValue, 0),
    memory: Math.round(memory),
    players: toNumber(playersValue, 0),
    maxPlayers: toNumber(maxPlayersValue, 0),
    imageUrl,
    connection,
    activeUsers: toNumber(usersMetric ? (usersMetric.RawValue ?? usersMetric.Value) : playersValue, 0),
  }
}

const getServerFacts = (serverInfo: Record<string, unknown>) => {
  const factValue = (keys: string[], fallback: string) => {
    const value = findDeepValue(serverInfo, keys)
    return value === undefined || value === null || String(value).trim() === '' ? fallback : String(value)
  }

  const name = factValue(['HostName', 'Hostname', 'ComputerName', 'MachineName', 'ServerName', 'Name', 'name', 'FriendlyName'], 'Unknown server')
  const appName = factValue(['AppName', 'appName', 'ApplicationName', 'applicationName'], 'AMP')
  const ampVersion = factValue(['AMPVersion', 'ampVersion', 'Version'], 'Unknown version')
  const ampBuild = factValue(['AMPBuild', 'ampBuild', 'Build'], 'Unknown build')
  const buildSpec = factValue(['BuildSpec', 'buildSpec'], 'Unknown build spec')
  const operatingSystem = factValue(['OperatingSystem', 'OperatingSystemName', 'OperatingSystemDescription', 'OSDescription', 'OSName', 'OSVersion', 'WindowsVersion', 'operatingSystem', 'OS', 'os', 'Platform'], 'Unknown OS')
  const uptime = parseAmpDuration(findDeepValue(serverInfo, ['HostUptime', 'HostUptimeSeconds', 'Uptime', 'UptimeSeconds', 'RunningUptime', 'SystemUptime', 'SystemUptimeSeconds', 'systemUptime'])).label
  const timestamp = factValue(['Timestamp', 'timestamp'], 'Not reported')

  return { name, appName, ampVersion, ampBuild, buildSpec, operatingSystem, uptime, timestamp }
}

const loginToAmp = async (
  config: ServerConfig,
  twoFactorCode = '',
  signal?: AbortSignal,
  savedSessionId = '',
  onLog?: (message: string, level?: LogLevel) => void,
) => {
  if (!config.baseUrl || !config.username || !config.password) {
    return {
      success: false,
      message: 'Add your AMP URL, username, and password.',
      sessionId: '',
      instances: [] as InstanceMetric[],
    }
  }

  const hasSavedSession = Boolean(savedSessionId)
  const authSessionId = hasSavedSession ? savedSessionId : ''

  if (hasSavedSession) {
    const sessionProbe = await fetchAmpJson(config.baseUrl, 'Core/GetModuleInfo', authSessionId, {}, signal, onLog)
    if (!sessionProbe.error) {
      const sessionPayload = sessionProbe.payload as Record<string, unknown> | null
      const sessionExists = Boolean(sessionPayload && !sessionPayload.Title && !sessionPayload.Message && !sessionPayload.Error)
      if (sessionExists) {
        const instancePayload = await fetchAmpJson(config.baseUrl, 'ADSModule/GetInstances', authSessionId, {}, signal, onLog)
        const items = extractInstanceList(instancePayload.payload)
        if (!isAmpErrorPayload(instancePayload.payload) && (items.length > 0 || sessionPayload?.Name || sessionPayload?.AppName || sessionPayload?.FriendlyName)) {
          const instanceMessage = isAmpErrorPayload(instancePayload.payload) ? summarizePayload(instancePayload.payload) : ''
          const statusResult = await fetchAmpJson(config.baseUrl, 'Core/GetStatus', authSessionId, {}, signal, onLog)
          const statusPayload = statusResult.payload && typeof statusResult.payload === 'object' ? statusResult.payload as Record<string, unknown> : {}
          return {
            success: true,
            message: instanceMessage ? `Connected, but instance data was unavailable: ${instanceMessage}` : 'Connected',
            serverInfo: { ...(sessionPayload ?? {}), ...statusPayload },
            sessionId: sessionProbe.sessionId || authSessionId,
            instances: items.length > 0 ? items.map((item, index) => normalizeInstanceMetric(item as Record<string, unknown>, index)) : [],
          }
        }
      }
    }
  }

  const loginPayload: Record<string, unknown> = {
    username: config.username,
    password: config.password,
    rememberMe: true,
  }

  if (twoFactorCode.trim()) {
    loginPayload.token = twoFactorCode.trim()
    loginPayload.twoFactorCode = twoFactorCode.trim()
    loginPayload.twoFactorPin = twoFactorCode.trim()
    loginPayload.totp = twoFactorCode.trim()
  }

  const loginRequest = await fetchAmpJson(config.baseUrl, 'Core/Login', '', loginPayload, signal, onLog)

  if (loginRequest.error) {
    return {
      success: false,
      message: loginRequest.error.includes('aborted') ? 'The AMP request timed out or was cancelled.' : `Could not reach AMP: ${loginRequest.error}`,
      sessionId: '',
      instances: [] as InstanceMetric[],
    }
  }

  const payload = loginRequest.payload
  const sessionId = loginRequest.sessionId || parseSessionToken(null, payload)
  const isAuthenticated = Boolean(sessionId) || Boolean(payload?.Status) || Boolean(payload?.status) || Boolean(payload?.Success)

  if (getTwoFactorStatus(payload) && !twoFactorCode.trim()) {
    return {
      success: false,
      message: 'AMP requires a 2FA code. Enter it in the field and retry.',
      sessionId: '',
      instances: [] as InstanceMetric[],
    }
  }

  if (!isAuthenticated) {
    const reason = payload?.Reason ?? payload?.reason ?? payload?.Message ?? payload?.message ?? 'AMP login failed.'
    return {
      success: false,
      message: getTwoFactorStatus(payload) ? 'AMP reported a 2FA challenge. Please check the authenticator code and retry.' : String(reason),
      sessionId: '',
      instances: [] as InstanceMetric[],
    }
  }

  const endpoints = ['ADSModule/GetInstances', 'Core/GetModuleInfo', 'Core/GetStatus']
  let instanceList: InstanceMetric[] = []
  let serverInfo: Record<string, unknown> = {}
  let instanceErrorMessage = ''

  for (const endpoint of endpoints) {
    if (signal?.aborted) {
      return {
        success: false,
        message: 'The AMP request was cancelled.',
        sessionId: '',
        serverInfo: {},
        instances: [] as InstanceMetric[],
      }
    }

    const result = await fetchAmpJson(config.baseUrl, endpoint, sessionId, {}, signal, onLog)

    if (result.error) {
      continue
    }

    if (endpoint === 'Core/GetModuleInfo' || endpoint === 'Core/GetStatus') {
      if (result.payload && typeof result.payload === 'object') {
        serverInfo = { ...serverInfo, ...(result.payload as Record<string, unknown>) }
      }
      continue
    }

    if (endpoint === 'ADSModule/GetInstances' && isAmpErrorPayload(result.payload)) {
      instanceErrorMessage = summarizePayload(result.payload)
      continue
    }

    const items = extractInstanceList(result.payload)
    if (items.length > 0) {
      instanceList = items.map((item, index) => normalizeInstanceMetric(item as Record<string, unknown>, index))
    }
  }

  if (instanceList.length === 0) {
    return {
      success: true,
      message: instanceErrorMessage
        ? `Connected, but instance data was unavailable: ${instanceErrorMessage}`
        : 'Connected but no instances were reported',
      serverInfo,
      sessionId,
      instances: [] as InstanceMetric[],
    }
  }

  return {
    success: true,
    message: 'Connected',
    serverInfo,
    sessionId,
    instances: instanceList,
  }
}

function App() {
  const [config, setConfig] = useState<ServerConfig>(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) {
      return defaultConfig
    }

    try {
      return { ...defaultConfig, ...JSON.parse(stored) }
    } catch {
      return defaultConfig
    }
  })

  const [instances, setInstances] = useState<InstanceMetric[]>([])
  const [serverInfo, setServerInfo] = useState<Record<string, unknown>>({})
  const [status, setStatus] = useState<'idle' | 'connecting' | 'online' | 'offline'>('idle')
  const [message, setMessage] = useState('Ready to connect')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [twoFactorCode, setTwoFactorCode] = useState('')
  const [sessionId, setSessionId] = useState(() => localStorage.getItem(SESSION_STORAGE_KEY) ?? '')
  const [activePage, setActivePage] = useState<'overview' | 'settings' | 'debug'>('overview')
  const [logEntries, setLogEntries] = useState<LogEntry[]>([
    { id: 1, timestamp: Date.now(), level: 'info', text: 'Waiting for AMP connection request.' },
  ])

  const appendLog = (text: string, level: LogLevel = 'info') => {
    const timestamp = Date.now()
    setLogEntries((current) => [{
      id: timestamp + Math.random(),
      timestamp,
      level,
      text,
    }, ...current].slice(0, 25))
  }

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  }, [config])

  useEffect(() => {
    localStorage.setItem(SESSION_STORAGE_KEY, sessionId)
  }, [sessionId])

  const stats = useMemo(() => {
    const filteredInstances = instances.filter((instance) => instance.name.toLowerCase() !== 'ads')
    const total = filteredInstances.length
    const online = filteredInstances.filter((instance) => instance.running).length
    const totalPlayers = filteredInstances.reduce((sum, instance) => sum + instance.players, 0)
    const averageCpu = total > 0 ? Math.round(filteredInstances.reduce((sum, instance) => sum + instance.cpu, 0) / total) : 0

    return { total, online, totalPlayers, averageCpu }
  }, [instances])

  const serverFacts = useMemo(() => getServerFacts(serverInfo), [serverInfo])

  const refreshDashboard = async () => {
    if (!config.baseUrl || !config.username || !config.password) {
      setStatus('offline')
      setMessage('Add your AMP URL, username, and password.')
      return
    }

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15000)

    setIsRefreshing(true)
    setStatus('connecting')
    setMessage('Connecting to AMP...')
    appendLog(`Connect attempt for ${config.baseUrl} using user ${config.username || 'unknown'}.`, 'info')

    const result = await loginToAmp(config, twoFactorCode, controller.signal, sessionId, appendLog)
    window.clearTimeout(timeout)

    if (controller.signal.aborted) {
      setStatus('offline')
      setMessage('The AMP request timed out. Check the server URL and credentials.')
      setInstances([])
      setIsRefreshing(false)
      return
    }

    if (!result.success) {
      setStatus('offline')
      setMessage(result.message)
      appendLog(`Auth result: ${result.message}`, 'error')
      setInstances([])
      setIsRefreshing(false)
      return
    }

    if (result.sessionId) {
      setSessionId(result.sessionId)
      localStorage.setItem(SESSION_STORAGE_KEY, result.sessionId)
    }

    setTwoFactorCode('')
    setServerInfo((result as { serverInfo?: Record<string, unknown> }).serverInfo ?? {})
    setStatus(result.success ? 'online' : 'offline')
    const finalMessage = result.message || (result.instances.length > 0 ? 'Connected successfully' : 'Connected but no instances were reported')
    setMessage(finalMessage)
    appendLog(`Result: ${finalMessage} (${result.instances.length} instances found).`, result.instances.length > 0 ? 'success' : 'warning')
    setInstances(result.instances)
    setIsRefreshing(false)
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    void refreshDashboard()
  }

  const renderOverview = () => (
    <section className="panel dashboard-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Overview</p>
          <h2>Server status</h2>
        </div>
        <button type="button" className="refresh-button" onClick={() => void refreshDashboard()} disabled={isRefreshing}>
          {isRefreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div className="stats-grid">
        <article className="stat-card"><span>Instances</span><strong>{stats.total}</strong></article>
        <article className="stat-card"><span>Running</span><strong>{stats.online}</strong></article>
        <article className="stat-card"><span>Players</span><strong>{stats.totalPlayers}</strong></article>
        <article className="stat-card"><span>CPU</span><strong>{stats.averageCpu}%</strong></article>
      </div>

      {instances.filter((instance) => instance.name.toLowerCase() !== 'ads').length === 0 ? (
        <div className="empty-state">
          <p>No instances are visible yet.</p>
          <small>Once the server connects, the running apps will appear here.</small>
        </div>
      ) : (
        <div className="instance-list">
          {instances
            .filter((instance) => instance.name.toLowerCase() !== 'ads')
            .map((instance) => (
              <a key={instance.id} className="instance-link" href={instance.id ? `${normalizeBaseUrl(config.baseUrl)}/instances/${instance.id}` : '#'} target="_blank" rel="noreferrer noopener">
                <article className="instance-card">
                  {instance.imageUrl ? <img src={instance.imageUrl} alt={instance.name} className="instance-image" /> : null}

                  <div className="instance-body">
                    <div className="instance-header">
                      <strong>{instance.name}</strong>
                      <span className={`status-pill ${instance.status}`}>{instance.status}</span>
                    </div>

                    <div className="instance-meta">
                      <span>Connection: {instance.connection || 'N/A'}</span>
                      <span>Active users: {instance.activeUsers}</span>
                    </div>

                    <div className="instance-metrics">
                      <span>CPU: {instance.cpu}%</span>
                      <span>RAM: {instance.memory}%</span>
                      <span>Players: {instance.players}/{instance.maxPlayers || 0}</span>
                      <span>Uptime: {instance.uptime ? formatDurationSeconds(instance.uptime) : 'N/A'}</span>
                    </div>
                  </div>
                </article>
              </a>
            ))}
        </div>
      )}

    </section>
  )

  const renderSettings = () => (
    <section className="panel settings-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Settings</p>
          <h2>AMP login</h2>
        </div>
        <span className={`status-pill ${status}`}>{status === 'idle' ? 'idle' : status}</span>
      </div>

      <form onSubmit={handleSubmit} className="server-form">
        <label>
          AMP URL
          <input
            value={config.baseUrl}
            onChange={(event) => setConfig((current) => ({ ...current, baseUrl: event.target.value }))}
            placeholder="https://your-amp-host:8080"
          />
        </label>

        <label>
          Username
          <input
            value={config.username}
            onChange={(event) => setConfig((current) => ({ ...current, username: event.target.value }))}
            placeholder="admin"
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={config.password}
            onChange={(event) => setConfig((current) => ({ ...current, password: event.target.value }))}
            placeholder="••••••••"
          />
        </label>

        <label>
          2FA code (if required)
          <input
            value={twoFactorCode}
            onChange={(event) => setTwoFactorCode(event.target.value)}
            placeholder="123456"
          />
        </label>

        <button type="submit" className="primary-button" disabled={isRefreshing}>
          {isRefreshing ? 'Connecting...' : 'Connect'}
        </button>
      </form>

      <p className="message-line">{message}</p>
    </section>
  )

  const renderDebug = () => (
    <section className="panel debug-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Debug</p>
          <h2>AMP host and requests</h2>
        </div>
      </div>

      <div className="debug-stack">
        <label>
          AMP host
          <input
            value={config.baseUrl}
            onChange={(event) => setConfig((current) => ({ ...current, baseUrl: event.target.value }))}
            placeholder="https://your-amp-host:8080"
          />
        </label>

        <div className="server-facts-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Server details</p>
              <h2>Server runtime</h2>
            </div>
          </div>
          <div className="facts-grid">
            <div className="fact-box"><span>Host name</span><strong>{serverFacts.name}</strong></div>
            <div className="fact-box"><span>App</span><strong>{serverFacts.appName}</strong></div>
            <div className="fact-box"><span>AMP version</span><strong>{serverFacts.ampVersion}</strong></div>
            <div className="fact-box"><span>Build</span><strong>{serverFacts.ampBuild}</strong></div>
            <div className="fact-box"><span>Build spec</span><strong>{serverFacts.buildSpec}</strong></div>
            <div className="fact-box"><span>OS</span><strong>{serverFacts.operatingSystem}</strong></div>
            <div className="fact-box"><span>Uptime</span><strong>{serverFacts.uptime}</strong></div>
            <div className="fact-box"><span>Build timestamp</span><strong>{serverFacts.timestamp}</strong></div>
          </div>
        </div>

        <div className="log-panel">
          <div className="panel-header compact-panel-header">
            <div>
              <p className="eyebrow">Live log</p>
              <h2>AMP requests</h2>
            </div>
          </div>

          <div className="log-list">
            {logEntries.map((entry) => (
              <div key={entry.id} className={`log-entry ${entry.level}`}>
                <time dateTime={new Date(entry.timestamp).toISOString()}>{formatLogTimestamp(entry.timestamp)}</time>
                <span className="log-badge">{entry.level}</span>
                <span>{entry.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">AMP</p>
          <h1>Dashboard</h1>
        </div>

        <nav className="topbar-nav" aria-label="Main navigation">
          <button type="button" className={activePage === 'overview' ? 'nav-button active' : 'nav-button'} onClick={() => setActivePage('overview')}>Overview</button>
          <button type="button" className={activePage === 'settings' ? 'nav-button active' : 'nav-button'} onClick={() => setActivePage('settings')}>Settings</button>
          <button type="button" className={activePage === 'debug' ? 'nav-button active' : 'nav-button'} onClick={() => setActivePage('debug')}>Debug</button>
        </nav>
      </header>

      <main className="page-content">
        {activePage === 'overview' && renderOverview()}
        {activePage === 'settings' && renderSettings()}
        {activePage === 'debug' && renderDebug()}
      </main>

    </div>
  )
}

export default App
