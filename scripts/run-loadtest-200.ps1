param(
  [string]$BaseUrl = "https://bot-dealer-backend.onrender.com",
  [int]$Total = 200
)

$ErrorActionPreference = "Stop"

function Invoke-TwilioLikeMessage {
  param(
    [string]$Endpoint,
    [string]$FromNumber,
    [string]$ToNumber,
    [string]$Message,
    [string]$MessageSid
  )

  $fromValue = "whatsapp:$FromNumber"
  $toValue = "whatsapp:$ToNumber"
  $body = "From=$([uri]::EscapeDataString($fromValue))&To=$([uri]::EscapeDataString($toValue))&Body=$([uri]::EscapeDataString($Message))&MessageSid=$([uri]::EscapeDataString($MessageSid))"

  $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $Endpoint -ContentType "application/x-www-form-urlencoded" -Body $body -TimeoutSec 40

  $replyText = ""
  try {
    [xml]$xml = $response.Content
    $replyText = [string]$xml.Response.Message.Body
  } catch {
    $replyText = [string]$response.Content
  }

  return @{
    statusCode = [int]$response.StatusCode
    reply = $replyText
  }
}

$twilioEndpoint = "$BaseUrl/webhooks/twilio/whatsapp"
$appointmentLookupBase = "$BaseUrl/dealer/db/conversations"
$dealerToNumber = "+15027801096"

$greetings = @(
  "hola",
  "hola bot",
  "buenos dias",
  "buenas tardes",
  "buenas noches",
  "hello",
  "hi",
  "hey",
  "holi",
  "saludos",
  "que tal",
  "hola equipo",
  "hola rey",
  "hola necesito info",
  "hola me ayudas",
  "good morning",
  "good evening",
  "hola amigo",
  "hola dealer",
  "hola rapido"
)

$appointmentRequests = @(
  "quiero una cita",
  "me gustaria agendar cita",
  "quiero agendar test drive",
  "puedo sacar cita hoy",
  "quiero ir al dealer",
  "quiero cita para ver un carro",
  "necesito appointment",
  "agendame una cita por favor",
  "quiero una visita",
  "quiero ir a ver opciones",
  "quiero pasar hoy",
  "me interesa agendar",
  "quiero test drive esta semana",
  "quiero cita con asesor",
  "quiero apartar horario",
  "quiero visitar el lote",
  "me agendan cita",
  "quiero cita para financiamiento",
  "podemos agendar cita",
  "quiero una cita rapida"
)

$timeSlots = @(
  "hoy 11am",
  "hoy 2pm",
  "hoy 4pm",
  "hoy 5pm",
  "manana 11am",
  "manana 2pm",
  "manana 4pm",
  "manana 5pm",
  "tomorrow 11am",
  "tomorrow 2pm",
  "tomorrow 4pm",
  "tomorrow 5pm",
  "hoy a las 16:00",
  "manana a las 15:00",
  "hoy 13:30",
  "manana 3:30pm",
  "today 4pm",
  "today 5pm",
  "hoy 17:00",
  "manana 12pm"
)

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$reportDir = Join-Path (Get-Location) "reports"
if (!(Test-Path $reportDir)) {
  New-Item -ItemType Directory -Path $reportDir | Out-Null
}

$results = New-Object System.Collections.Generic.List[object]

for ($i = 1; $i -le $Total; $i++) {
  $testId = "T{0:D3}" -f $i
  $fromNumber = "+1830475{0:D4}" -f $i
  $sessionId = "wa:whatsapp:$fromNumber"

  $greeting = $greetings[($i - 1) % $greetings.Count]
  $request = $appointmentRequests[(($i - 1) * 3) % $appointmentRequests.Count]
  $slot = $timeSlots[(($i - 1) * 7) % $timeSlots.Count]

  $stepReplies = @()
  $allStatus200 = $true
  $errorText = ""

  try {
    $sid1 = "SMLOAD${timestamp}${i}A"
    $r1 = Invoke-TwilioLikeMessage -Endpoint $twilioEndpoint -FromNumber $fromNumber -ToNumber $dealerToNumber -Message $greeting -MessageSid $sid1
    if ($r1.statusCode -ne 200) { $allStatus200 = $false }
    $stepReplies += $r1.reply

    Start-Sleep -Milliseconds 120

    $sid2 = "SMLOAD${timestamp}${i}B"
    $r2 = Invoke-TwilioLikeMessage -Endpoint $twilioEndpoint -FromNumber $fromNumber -ToNumber $dealerToNumber -Message $request -MessageSid $sid2
    if ($r2.statusCode -ne 200) { $allStatus200 = $false }
    $stepReplies += $r2.reply

    Start-Sleep -Milliseconds 120

    $sid3 = "SMLOAD${timestamp}${i}C"
    $r3 = Invoke-TwilioLikeMessage -Endpoint $twilioEndpoint -FromNumber $fromNumber -ToNumber $dealerToNumber -Message $slot -MessageSid $sid3
    if ($r3.statusCode -ne 200) { $allStatus200 = $false }
    $stepReplies += $r3.reply
  } catch {
    $allStatus200 = $false
    $errorText = $_.Exception.Message
  }

  Start-Sleep -Milliseconds 120

  $appointmentFound = $false
  $appointmentId = $null
  $appointmentAt = $null
  $appointmentStatus = $null
  $appointmentState = $null
  $leadStatus = $null

  try {
    $lookupUrl = "$appointmentLookupBase/$([uri]::EscapeDataString($sessionId))/appointment"
    $lookup = Invoke-RestMethod -Method Get -Uri $lookupUrl -TimeoutSec 40
    if ($null -ne $lookup) {
      if ($null -ne $lookup.appointment) {
        $appointmentFound = $true
        $appointmentId = $lookup.appointment.id
        $appointmentAt = $lookup.appointment.scheduled_at
        $appointmentStatus = $lookup.appointment.status
        $appointmentState = $lookup.appointment.confirmation_state
      }
      if ($null -ne $lookup.lead) {
        $leadStatus = $lookup.lead.status
      }
    }
  } catch {
    if ([string]::IsNullOrWhiteSpace($errorText)) {
      $errorText = "Lookup failed: $($_.Exception.Message)"
    }
  }

  $results.Add([pscustomobject]@{
      test_id = $testId
      session_id = $sessionId
      from_number = $fromNumber
      greeting = $greeting
      appointment_request = $request
      slot_message = $slot
      webhook_http_200 = $allStatus200
      appointment_created = $appointmentFound
      appointment_id = $appointmentId
      appointment_scheduled_at = $appointmentAt
      appointment_status = $appointmentStatus
      confirmation_state = $appointmentState
      lead_status = $leadStatus
      last_reply = ($stepReplies | Select-Object -Last 1)
      error = $errorText
    })

  if (($i % 25) -eq 0) {
    Write-Output "Progress: $i / $Total"
  }
}

$jsonPath = Join-Path $reportDir "loadtest-200-$timestamp.json"
$csvPath = Join-Path $reportDir "loadtest-200-$timestamp.csv"
$summaryPath = Join-Path $reportDir "loadtest-200-$timestamp-summary.txt"

$results | ConvertTo-Json -Depth 6 | Set-Content -Path $jsonPath -Encoding UTF8
$results | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8

$totalDone = $results.Count
$okWebhook = ($results | Where-Object { $_.webhook_http_200 -eq $true }).Count
$created = ($results | Where-Object { $_.appointment_created -eq $true }).Count
$failedCreate = $totalDone - $created
$failedWebhook = $totalDone - $okWebhook

$summary = @(
  "Load test summary",
  "Base URL: $BaseUrl",
  "Timestamp: $timestamp",
  "Total tests: $totalDone",
  "Webhook 200 OK: $okWebhook",
  "Webhook non-200/errors: $failedWebhook",
  "Appointments created: $created",
  "Appointments NOT created: $failedCreate",
  "CSV: $csvPath",
  "JSON: $jsonPath"
)

$summary | Set-Content -Path $summaryPath -Encoding UTF8
$summary | ForEach-Object { Write-Output $_ }
