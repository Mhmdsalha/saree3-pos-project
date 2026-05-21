export type StoreType = 'supermarket' | 'clothing' | 'pharmacy' | 'cosmetics'
export type LauncherMode = 'host' | 'client'

export type StoreProfile = {
  id: number
  store_id: string
  store_name: string
  country: string
  currency: string
  store_type: StoreType
  logo_path?: string | null
  phone?: string | null
  address?: string | null
  initialized_at: string
  created_at: string
  updated_at: string
}

export type LauncherStatus = {
  initialized: boolean
  setup_state?: string | null
  setup_reason?: string | null
  has_admin: boolean
  server_port: number
  runtime: Record<string, unknown>
  store?: StoreProfile | null
  license?: LicenseStatus | null
}

export type RuntimeHealth = {
  status: string
  database_backend: string
  database_ok?: boolean | null
  timezone?: {
    configured?: string
    resolved?: string
  }
  local_https?: {
    enabled?: boolean
    active?: boolean
    lan_ip?: string | null
    port?: number | null
    desktop_url?: string | null
    mobile_url?: string | null
    websocket_url_template?: string | null
    cert_lan_ip?: string | null
    cert_covers_current_ip?: boolean
    restart_required?: boolean
    status?: string | null
    message?: string | null
  }
  telegram_polling?: {
    enabled?: boolean
    configured?: boolean
    active?: boolean
    error?: string | null
  }
  frontend?: {
    desktop_built?: boolean
    mobile_built?: boolean
  }
  license?: {
    license_status?: string | null
    license_type?: string | null
    trial_expires_at?: string | null
    expires_at?: string | null
    remaining_days?: number | null
    is_blocked?: boolean
    reason?: string | null
  }
}

export type SetupPayload = {
  store_name: string
  country: string
  currency: string
  store_type: StoreType
  phone?: string | null
  address?: string | null
  logo_path?: string | null
  server_port?: number | null
  admin_name: string
  admin_username: string
  admin_password: string
  secret_question: string
  secret_answer: string
  secret_answer_confirm: string
}

export type TelegramSettings = {
  telegram_enabled: boolean
  telegram_auto_send: boolean
  telegram_mode: 'pdf' | 'text'
  bot_username?: string | null
  bot_status: string
  link?: string | null
  store_linked?: boolean
  store_linked_at?: string | null
  store_linked_username?: string | null
}

export type ManagerTelegramSetupStatus = {
  bot_username?: string | null
  bot_token_configured?: boolean
  telegram_setup_problem?: string | null
  link?: string | null
  linked: boolean
  manager_telegram_masked?: string | null
  manager_telegram_username?: string | null
  verified_at?: string | null
}

export type AdminRecoveryStatus = {
  available: boolean
  host_only: boolean
  has_admin: boolean
  manager_telegram_linked: boolean
  manager_telegram_masked?: string | null
  secret_question_configured: boolean
  recovery_configured: boolean
  store_id?: string | null
  installation_id?: string | null
}

export type AdminRecoveryOtpRequest = {
  ok: boolean
  expires_in_seconds: number
  resend_cooldown_seconds: number
  manager_telegram_masked?: string | null
}

export type AdminRecoveryOtpVerify = {
  ok: boolean
  recovery_token: string
  secret_question: string
}

export type AdminRecoverySecretVerify = {
  ok: boolean
  admin_username: string
  admin_user_id: number
}

export type AdminRecoveryReset = {
  ok: boolean
  admin_username: string
}

export type LauncherCustomer = {
  id: number
  customer_name?: string | null
  phone_number: string
  telegram_chat_id?: string | null
  telegram_activation_status: string
}

export type AppPaths = {
  app_data_dir: string
  config_dir: string
  data_dir: string
  uploads_dir: string
  backups_dir: string
  database_path: string
  logo_dir: string
}

export type LauncherConfig = {
  mode?: LauncherMode | null
  client_base_url?: string | null
  installation_id: string
}

export type LicenseStatus = {
  license_id?: string | null
  sequence_number?: number | null
  store_id?: string | null
  installation_id: string
  license_type: string
  subscription_term?: string | null
  license_status: 'pending' | 'trial_active' | 'trial_expired' | 'active' | 'invalid'
  plan?: string | null
  trial_started_at?: string | null
  trial_expires_at?: string | null
  activated_at?: string | null
  issued_at?: string | null
  expires_at?: string | null
  status_reason?: string | null
  consumed_at?: string | null
  last_seen_local_at?: string | null
  current_time_utc?: string | null
  remaining_days?: number | null
  time_source?: string | null
  time_sync_status?: string | null
  time_trusted?: boolean | null
  time_reason?: string | null
  time_server?: string | null
  is_blocked: boolean
  reason?: string | null
  activation_request_url?: string | null
}

export type Storefront = {
  initialized: boolean
  setup_state?: string | null
  setup_reason?: string | null
  store_name: string
  country?: string | null
  currency?: string | null
  store_type?: string | null
  logo_path?: string | null
  phone?: string | null
  address?: string | null
}

export type NetworkInfo = {
  lan_ip: string
  desktop_url: string
  mobile_url: string
}

export type ServerState = {
  status: 'stopped' | 'starting' | 'running' | 'error'
  port: number
  pid?: number | null
  url: string
  mobile_url: string
  error?: string | null
}
