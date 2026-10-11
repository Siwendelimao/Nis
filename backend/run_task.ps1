for ($i=1; $i -le 6; $i++) {
    Add-Content -Path 'D:/nis0924/_testdata_be/_e2e_cloneA.log' -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') Step $i"
    Start-Sleep -Seconds 5
}
Write-Output '分身1完成'
