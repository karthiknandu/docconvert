@echo off
title DocConvert laptop helper
cd /d "%~dp0"
where py >nul 2>nul && (py -3 docconvert_helper.py) || (python docconvert_helper.py)
pause
