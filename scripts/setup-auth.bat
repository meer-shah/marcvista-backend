@echo off
echo ============================================
echo MarkVista Auth Setup & Migration Script
echo ============================================
echo.

REM Check if MongoDB is running
echo [1/4] Checking MongoDB connection...
mongosh --eval "db.runCommand({ ping: 1 })" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] MongoDB is not running or not installed.
    echo.
    echo Please start MongoDB first:
    echo   - If MongoDB is installed as a service: net start MongoDB
    echo   - Or run: mongod --dbpath "data"
    echo.
    pause
    exit /b 1
)
echo [OK] MongoDB is running.
echo.

REM Run migration script
echo [2/4] Running data migration...
node scripts\migrate-data.js
if errorlevel 1 (
    echo [ERROR] Migration failed.
    pause
    exit /b 1
)
echo.

echo [3/4] Migration completed successfully!
echo.

echo ============================================
echo SETUP COMPLETE
echo ============================================
echo.
echo Default System User Credentials:
echo   Email:    admin@markvista.local
echo   Password: admin123
echo.
echo IMPORTANT: Change this password after first login!
echo.
echo Next Steps:
echo   1. Ensure backend is running: npm start (in BACKEND folder)
echo   2. Ensure frontend is running: npm run dev (in frontend folder)
echo   3. Open http://localhost:8080/login
echo   4. Login with the credentials above
echo.
echo All existing data has been migrated to this user account.
echo.
pause
