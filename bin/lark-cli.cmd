@echo off
rem lark-cli wrapper: 清除 hermes/openclaw/lark-channel 检测变量（set VAR= 即删除该变量）
set "HERMES_HOME="
set "HERMES_GIT_BASH_PATH="
set "OPENCLAW_HOME="
set "LARK_CHANNEL="
"%USERPROFILE%\.lark-cli\node_modules\@larksuite\cli\bin\lark-cli.exe" %*
