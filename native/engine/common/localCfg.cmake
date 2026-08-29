## Add or overwrite options from cfg.cmake. 
## This file is ignored from git.
# set(NODE_EXECUTABLE /opt/...)

# ColorMusic: 关闭 V8 inspector 调试服务器（Android 16 上枚举网卡会报
# Permission denied 并打印大量错误，且 debug 构建默认开启远程调试无必要）
set(USE_V8_DEBUGGER OFF CACHE BOOL "Compile v8 inspector ws server" FORCE)
