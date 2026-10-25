; 阳鸽安装期两件事：
; 1) 防火墙放行——屏幕协助 / 文件直传需要新建入站 TCP 连接。规则已存在（装过 1.3.2+）时
;    直接跳过，静默升级（决议 #166 第三步）全程零 UAC；首次安装才请求一次管理员授权。
;    规则名带 "YangGe LAN" 前缀，卸载不清理（指向已删除程序路径的规则系统自动忽略）。
; 2) 安装器自留——把当前安装包复制到本机用户数据目录的 data\updates（决议 #166 的 nsis 形态），
;    本机即成为局域网更新源，旧版本同事会在应用里看到「内网有新版」并直接从本机拉包。
!include "LogicLib.nsh"
!macro customInstall
  nsExec::ExecToStack 'netsh advfirewall firewall show rule name="YangGe LAN In"'
  Pop $R0
  Pop $R1
  ${If} $R0 != 0
    ExecShell "runas" "$SYSDIR\cmd.exe" "/c netsh advfirewall firewall add rule name=$\"YangGe LAN In$\" dir=in action=allow program=$\"$INSTDIR\YangGe.exe$\" enable=yes & netsh advfirewall firewall add rule name=$\"YangGe LAN Out$\" dir=out action=allow program=$\"$INSTDIR\YangGe.exe$\" enable=yes"
  ${EndIf}
  CreateDirectory "$APPDATA\阳鸽\data\updates"
  CopyFiles /SILENT "$EXEPATH" "$APPDATA\阳鸽\data\updates\"
!macroend
