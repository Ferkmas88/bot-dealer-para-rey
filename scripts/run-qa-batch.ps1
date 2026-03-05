param(
  [string]$BaseUrl = "https://bot-dealer-backend.onrender.com",
  [int]$Total = 10,
  [int]$PauseMs = 1400,
  [string]$RunId = "",
  [switch]$NoCleanup
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($RunId)) {
  $RunId = "qa-" + (Get-Date -Format "yyyyMMdd-HHmmss")
}

$reportDir = Join-Path (Get-Location) "reports"
if (!(Test-Path $reportDir)) {
  New-Item -ItemType Directory -Path $reportDir | Out-Null
}

$twilioEndpoint = "$BaseUrl/webhooks/twilio/whatsapp"
$appointmentLookupBase = "$BaseUrl/dealer/db/conversations"
$deleteConversationBase = "$BaseUrl/dealer/db/conversations"

$dealerToNumber = "+15027801096"

$dateOptions = @("manana 11am", "manana 4pm", "manana 1pm", "manana 2pm", "manana 5pm", "manana 10am")
$typeOptions = @("SUV", "Sedan", "Pickup")

$records = New-Object System.Collections.Generic.List[object]
$sessionIds = New-Object System.Collections.Generic.List[string]
$aborted = $false
$failureReason = ""

function New-MessageSid {
  param(
    [string]$Run,
    [int]$Index,
    [int]$Step
  )
  $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  return "SM-$Run-$Index-$Step-$stamp"
}

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

  $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $Endpoint -ContentType "application/x-www-form-urlencoded" -Body $body -TimeoutSec 45
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

function Get-ConversationAppointmentSnapshot {
  param(
    [string]$LookupBase,
    [string]$SessionId
  )
  $url = "$LookupBase/$([uri]::EscapeDataString($SessionId))/appointment"
  return Invoke-RestMethod -Method Get -Uri $url -TimeoutSec 45
}

function Remove-TestConversation {
  param(
    [string]$DeleteBase,
    [string]$SessionId
  )
  $url = "$DeleteBase/$([uri]::EscapeDataString($SessionId))"
  Invoke-RestMethod -Method Delete -Uri $url -TimeoutSec 45 | Out-Null
}

try {
  for ($i = 1; $i -le $Total; $i++) {
    $fromNumber = "+1502999{0:D4}" -f $i
    $sessionId = "wa:whatsapp:$fromNumber"
    $sessionIds.Add($sessionId)

    $dateMessage = $dateOptions[($i - 1) % $dateOptions.Count]
    $typeMessage = $typeOptions[($i - 1) % $typeOptions.Count]
    $customerName = "Cliente $i $RunId"

    $messages = @(
      "hola",
      "2",
      $customerName,
      $dateMessage,
      $typeMessage,
      "que carros tienen disponibles?",
      "cual es el numero de Rey?",
      "como contacto al mecanico?"
    )

    $replies = @()
    $all200 = $true
    $errorText = ""

    for ($step = 1; $step -le $messages.Count; $step++) {
      try {
        $sid = New-MessageSid -Run $RunId -Index $i -Step $step
        $resp = Invoke-TwilioLikeMessage -Endpoint $twilioEndpoint -FromNumber $fromNumber -ToNumber $dealerToNumber -Message $messages[$step - 1] -MessageSid $sid
        if ($resp.statusCode -ne 200) { $all200 = $false }
        $replies += [string]$resp.reply
      } catch {
        $all200 = $false
        if ([string]::IsNullOrWhiteSpace($errorText)) {
          $errorText = $_.Exception.Message
        }
        $replies += ""
      }
      Start-Sleep -Milliseconds $PauseMs
    }

    $leadStatus = $null
    $leadName = $null
    $appointmentId = $null
    $appointmentStatus = $null
    $appointmentState = $null
    $appointmentNotes = $null
    $appointmentScheduledAt = $null

    try {
      $snapshot = Get-ConversationAppointmentSnapshot -LookupBase $appointmentLookupBase -SessionId $sessionId
      if ($null -ne $snapshot.lead) {
        $leadStatus = $snapshot.lead.status
        $leadName = $snapshot.lead.name
      }
      if ($null -ne $snapshot.appointment) {
        $appointmentId = $snapshot.appointment.id
        $appointmentStatus = $snapshot.appointment.status
        $appointmentState = $snapshot.appointment.confirmation_state
        $appointmentNotes = $snapshot.appointment.notes
        $appointmentScheduledAt = $snapshot.appointment.scheduled_at
      }
    } catch {
      if ([string]::IsNullOrWhiteSpace($errorText)) {
        $errorText = "lookup failed: $($_.Exception.Message)"
      }
    }

    $orderOk =
      ($replies.Count -ge 4) -and
      ($replies[1] -match "nombre") -and
      ($replies[2] -match "dia y hora|d[ií]a y hora") -and
      ($replies[3] -match "tipo de carro")
    $appointmentOk =
      ($null -ne $appointmentId) -and
      ($appointmentStatus -eq "PENDING") -and
      ($appointmentState -eq "PROPOSED")
    $carsOk = ($replies.Count -ge 6) -and ($replies[5] -match "opciones disponibles|Te comparto|Tengo|unidades disponibles|No tengo")
    $reyOk = ($replies.Count -ge 7) -and ($replies[6] -match "\+1 \(502\) 576-8116") -and -not ($replies[6] -match "780-1096")
    $mechanicOk = ($replies.Count -ge 8) -and ($replies[7] -match "Pronto tendremos esa informacion disponible")

    $completed =
      $all200 -and
      $orderOk -and
      $appointmentOk -and
      $carsOk -and
      $reyOk -and
      $mechanicOk -and
      [string]::IsNullOrWhiteSpace($errorText)

    $records.Add([pscustomobject]@{
        run_id = $RunId
        session_id = $sessionId
        from_number = $fromNumber
        completed = $completed
        webhook_http_200 = $all200
        order_ok = $orderOk
        appointment_ok = $appointmentOk
        cars_ok = $carsOk
        rey_ok = $reyOk
        mechanic_ok = $mechanicOk
        lead_name = $leadName
        lead_status = $leadStatus
        appointment_id = $appointmentId
        appointment_status = $appointmentStatus
        confirmation_state = $appointmentState
        appointment_notes = $appointmentNotes
        appointment_scheduled_at = $appointmentScheduledAt
        reply_step_1 = if ($replies.Count -ge 1) { $replies[0] } else { "" }
        reply_step_2 = if ($replies.Count -ge 2) { $replies[1] } else { "" }
        reply_step_3 = if ($replies.Count -ge 3) { $replies[2] } else { "" }
        reply_step_4 = if ($replies.Count -ge 4) { $replies[3] } else { "" }
        reply_step_5 = if ($replies.Count -ge 5) { $replies[4] } else { "" }
        reply_step_6 = if ($replies.Count -ge 6) { $replies[5] } else { "" }
        reply_step_7 = if ($replies.Count -ge 7) { $replies[6] } else { "" }
        reply_step_8 = if ($replies.Count -ge 8) { $replies[7] } else { "" }
        error = $errorText
      })

    Write-Output "Progress: $i / $Total"
  }
} catch {
  $aborted = $true
  $failureReason = $_.Exception.Message
} finally {
  if (-not $NoCleanup) {
    $cleanupOk = 0
    $cleanupFail = 0
    foreach ($sid in $sessionIds) {
      try {
        Remove-TestConversation -DeleteBase $deleteConversationBase -SessionId $sid
        $cleanupOk += 1
      } catch {
        $cleanupFail += 1
      }
    }
    Write-Output "Cleanup completed: deleted=$cleanupOk failed=$cleanupFail"
  } else {
    Write-Output "Cleanup skipped due to -NoCleanup."
  }
}

$jsonPath = Join-Path $reportDir "qa-batch-$RunId.json"
$csvPath = Join-Path $reportDir "qa-batch-$RunId.csv"
$summaryPath = Join-Path $reportDir "qa-batch-$RunId-summary.txt"

$records | ConvertTo-Json -Depth 8 | Set-Content -Path $jsonPath -Encoding UTF8
$records | Export-Csv -Path $csvPath -NoTypeInformation -Encoding UTF8

$completedRows = $records | Where-Object { $_.completed -eq $true }
$totalDone = $records.Count
$totalCompleted = $completedRows.Count
$totalNotCompleted = $totalDone - $totalCompleted
$orderOkCount = ($completedRows | Where-Object { $_.order_ok -eq $true }).Count
$appointmentOkCount = ($completedRows | Where-Object { $_.appointment_ok -eq $true }).Count
$carsOkCount = ($completedRows | Where-Object { $_.cars_ok -eq $true }).Count
$reyOkCount = ($completedRows | Where-Object { $_.rey_ok -eq $true }).Count
$mechanicOkCount = ($completedRows | Where-Object { $_.mechanic_ok -eq $true }).Count

$summary = @(
  "QA batch summary",
  "Run ID: $RunId",
  "Base URL: $BaseUrl",
  "Total sessions attempted: $totalDone",
  "Completed sessions: $totalCompleted",
  "Not completed sessions: $totalNotCompleted",
  "Metrics calculated only on completed sessions:",
  "  order_ok: $orderOkCount",
  "  appointment_ok: $appointmentOkCount",
  "  cars_ok: $carsOkCount",
  "  rey_ok: $reyOkCount",
  "  mechanic_ok: $mechanicOkCount",
  "Aborted: $aborted",
  "Failure reason: $failureReason",
  "CSV: $csvPath",
  "JSON: $jsonPath"
)

$summary | Set-Content -Path $summaryPath -Encoding UTF8
$summary | ForEach-Object { Write-Output $_ }
