@echo off
rem Lance CompaGelato. Ce fichier est appele par launch.vbs (raccourci du
rem Bureau) : il ne doit normalement jamais etre ouvert directement.
cd /d "%~dp0"
call npm start
