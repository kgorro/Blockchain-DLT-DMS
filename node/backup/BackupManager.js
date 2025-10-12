// backup/BackupManager.js
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const crypto = require('crypto');

class BackupManager {
  constructor(nodeId) {
    this.nodeId = nodeId;
    this.backupDir = path.join(__dirname, '../backups');
    this.remoteBackupEnabled = process.env.REMOTE_BACKUP_ENABLED === 'true';
  }

  async initialize() {
    await fs.mkdir(this.backupDir, { recursive: true });
    console.log('✅ Backup manager initialized');
  }

  /**
   * Create full backup
   */
  async createBackup(blockchain, description = 'Scheduled backup') {
    console.log('\n💾 BACKUP STARTED');
    console.log('='.repeat(60));

    const timestamp = Date.now();
    const backupId = `backup-${this.nodeId}-${timestamp}`;
    const backupPath = path.join(this.backupDir, backupId);

    try {
      await fs.mkdir(backupPath, { recursive: true });

      // 1. Backup blockchain data
      const blockchainData = {
        chain: blockchain.chain.map(b => b.toJSON()),
        authorities: Array.from(blockchain.authorities),
        authorityList: blockchain.authorityList,
        nodeId: this.nodeId,
        timestamp: timestamp
      };
      await fs.writeFile(
        path.join(backupPath, 'blockchain.json'),
        JSON.stringify(blockchainData, null, 2)
      );

      // 2. Backup uploads directory
      const uploadsDir = path.join(__dirname, '../uploads');
      if (fsSync.existsSync(uploadsDir)) {
        await execPromise(`cp -r "${uploadsDir}" "${backupPath}/uploads"`);
      }

      // 3. Backup database (MongoDB)
      const dbName = process.env.MONGODB_URI?.split('/').pop() || `blockchain-${this.nodeId}`;
      try {
        await execPromise(
          `mongodump --db="${dbName}" --out="${backupPath}/mongodb" --quiet`
        );
      } catch (error) {
        console.log('⚠️ MongoDB backup skipped:', error.message);
      }

      // 4. Create backup manifest
      const manifest = {
        backupId,
        nodeId: this.nodeId,
        timestamp,
        date: new Date(timestamp).toISOString(),
        description,
        blockchainState: {
          blockCount: blockchain.chain.length,
          lastBlockHash: blockchain.chain[blockchain.chain.length - 1].hash
        },
        files: await this.getDirectoryTree(backupPath)
      };

      // Calculate backup hash
      manifest.hash = await this.calculateBackupHash(backupPath);

      await fs.writeFile(
        path.join(backupPath, 'manifest.json'),
        JSON.stringify(manifest, null, 2)
      );

      // 5. Compress backup
      const archivePath = `${backupPath}.tar.gz`;
      await execPromise(`tar -czf "${archivePath}" -C "${this.backupDir}" "${backupId}"`);
      
      // Remove uncompressed backup
      await execPromise(`rm -rf "${backupPath}"`);

      const archiveSize = (await fs.stat(archivePath)).size;

      console.log('✅ BACKUP COMPLETED');
      console.log(`📦 Archive: ${path.basename(archivePath)}`);
      console.log(`💾 Size: ${(archiveSize / 1024 / 1024).toFixed(2)} MB`);
      console.log(`🔐 Hash: ${manifest.hash.substring(0, 32)}...`);
      console.log('='.repeat(60) + '\n');

      // Upload to remote if enabled
      if (this.remoteBackupEnabled) {
        await this.uploadToRemote(archivePath, manifest);
      }

      return {
        success: true,
        backupId,
        manifest,
        archivePath,
        size: archiveSize
      };

    } catch (error) {
      console.error('❌ BACKUP FAILED:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Calculate hash of backup directory
   */
  async calculateBackupHash(dirPath) {
    const files = await this.getAllFiles(dirPath);
    const hash = crypto.createHash('sha256');

    for (const file of files.sort()) {
      const content = await fs.readFile(file);
      hash.update(content);
    }

    return hash.digest('hex');
  }

  /**
   * Get all files recursively
   */
  async getAllFiles(dirPath, arrayOfFiles = []) {
    const files = await fs.readdir(dirPath);

    for (const file of files) {
      const filePath = path.join(dirPath, file);
      const stat = await fs.stat(filePath);

      if (stat.isDirectory()) {
        arrayOfFiles = await this.getAllFiles(filePath, arrayOfFiles);
      } else {
        arrayOfFiles.push(filePath);
      }
    }

    return arrayOfFiles;
  }

  /**
   * Get directory tree structure
   */
  async getDirectoryTree(dirPath, prefix = '') {
    const items = await fs.readdir(dirPath);
    const tree = [];

    for (const item of items) {
      const itemPath = path.join(dirPath, item);
      const stat = await fs.stat(itemPath);

      if (stat.isDirectory()) {
        tree.push(`${prefix}📁 ${item}/`);
        const subTree = await this.getDirectoryTree(itemPath, prefix + '  ');
        tree.push(...subTree);
      } else {
        tree.push(`${prefix}📄 ${item} (${(stat.size / 1024).toFixed(2)} KB)`);
      }
    }

    return tree;
  }

  /**
   * Upload backup to remote storage (S3, IPFS, etc.)
   */
  async uploadToRemote(archivePath, manifest) {
    console.log('☁️ Uploading to remote storage...');
    
    // TODO: Implement actual remote storage
    // Examples:
    // - AWS S3
    // - IPFS
    // - Google Cloud Storage
    // - Azure Blob Storage
    
    console.log('⚠️ Remote backup not configured');
    return null;
  }

  /**
   * List all backups
   */
  async listBackups() {
    const files = await fs.readdir(this.backupDir);
    const backups = [];

    for (const file of files) {
      if (file.endsWith('.tar.gz')) {
        const filePath = path.join(this.backupDir, file);
        const stat = await fs.stat(filePath);
        
        backups.push({
          filename: file,
          path: filePath,
          size: stat.size,
          created: stat.birthtime
        });
      }
    }

    return backups.sort((a, b) => b.created - a.created);
  }

  /**
   * Restore from backup
   */
  async restoreBackup(backupId) {
    console.log(`🔄 Restoring backup: ${backupId}`);
    
    const archivePath = path.join(this.backupDir, `${backupId}.tar.gz`);
    
    if (!fsSync.existsSync(archivePath)) {
      throw new Error('Backup not found');
    }

    // Extract backup
    const extractPath = path.join(this.backupDir, 'restore-temp');
    await fs.mkdir(extractPath, { recursive: true });
    await execPromise(`tar -xzf "${archivePath}" -C "${extractPath}"`);

    // Read manifest
    const manifestPath = path.join(extractPath, backupId, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));

    console.log('✅ Backup restored successfully');
    console.log('⚠️ RESTART REQUIRED to apply changes');

    return {
      success: true,
      manifest,
      extractPath: path.join(extractPath, backupId)
    };
  }

  /**
   * Start periodic backups
   */
  startPeriodicBackups(blockchain, intervalHours = 6) {
    console.log(`⏰ Periodic backups enabled (every ${intervalHours} hours)`);
    
    setInterval(async () => {
      await this.createBackup(blockchain, 'Automatic scheduled backup');
    }, intervalHours * 3600000);

    // Initial backup after 5 minutes
    setTimeout(async () => {
      await this.createBackup(blockchain, 'Initial automatic backup');
    }, 300000);
  }
}

module.exports = BackupManager;