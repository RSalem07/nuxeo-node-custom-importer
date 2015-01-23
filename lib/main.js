var nuxeo = require('nuxeo'),
  async = require('async'),
  path = require('path'),
  fs = require('fs'),
  rest = require('restler');

exports.import = function(config) {
  var client = new nuxeo.Client({
    baseURL: config.baseURL,
    username: config.username,
    password: config.password,
    timeout: config.timeout
  });

  var localPath = config.localPath;
  // TODO replace with path.isAbsolute() when switching to node 0.11.x
  if (localPath[0] !== '/') {
    localPath = path.join(process.cwd(), localPath);
  }

  // Format: Type_source_lifecycestate_dc:valid_dc:creator_filename.doc
  var readFilename = function(filename, isFolder) {
    var eles = filename.split('_');

    // when no Type defined, or only Type and filename
    var properties = {};
    if (eles.length === 1) {
      properties['dc:title'] = eles[0];
      return {
        type: isFolder ? 'Folder' : 'File',
        filename: eles[0],
        properties: properties
      }
    } else if (eles.length === 2) {
      properties['dc:title'] = eles[1];
      return {
        type: eles[0],
        filename: eles[1],
        properties: properties
      }
    }

    // Wrong format
    if (eles.length < 6) {
      console.error('Wrong filename format: ' + filename);
      return null;
    }

    // compute the transition to follow
    var transition;
    switch (eles[2]) {
      case 'approved':
        transition = 'approve';
        break;
      case 'obsolete':
        transition = 'obsolete';
        break;
      case 'deleted':
        transition = 'delete';
        break;
    }

    // compute the default properties
    var properties = {};
    if (eles[3]) {
      properties['dc:valid'] = eles[3];
    }
    if (eles[4]) {
      properties['dc:creator'] = eles[4];
    }
    if (eles[1]) {
      properties['dc:source'] = eles[1];
    }
    properties['dc:title'] = eles[5];

    return {
      type: eles[0],
      lifecycleState: eles[2],
      transition: transition,
      properties: properties,
      filename: eles[5]
    }
  };

  var createDocumentFromFile = function(file, remotePath, callback) {
    if (config.verbose) {
      console.log('Create document from file: ' + file);
    }

    var metadata = readFilename(path.basename(file), false);
    // Note type
    if (metadata.type === 'Note') {
      var content = fs.readFileSync(file, {
        encoding: 'UTF-8'
      });
      metadata.properties['note:note'] = content;
    }

    client.document(remotePath)
      .create({
        type: metadata.type,
        name: metadata.filename,
        properties: metadata.properties
      }, function(err, doc) {
        if (err) {
          callback(err, file, null, metadata);
        } else {
          if (config.verbose) {
            console.log('Created remote file: ' + doc.path);
          }

          if (callback) {
            callback(null, file, doc, metadata);
          }
        }
      });
  };

  var uploadBlob = function(file, doc, metadata, callback) {
    if (config.verbose) {
      console.log('Upload blob for: ' + file);
    }

    if (metadata.type === 'Note') {
      callback(null, doc, metadata);
      return;
    }

    // attach the Blob
    // create the uploader bound to the operation
    var uploader = client.operation('Blob.Attach')
      .params({
        document: doc.uid,
        save: true,
        xpath: 'file:content'
      })
      .uploader();

    // upload the file
    uploader.uploadFile(rest.file(file, null, fs.statSync(file).size, null, null), function(err, data) {
      if (err) {
        if (config.verbose) {
          console.error('Error while uploading file: ' + file);
        }
        callback(err);
        return;
      }

      // when done, execute the operation
      uploader.execute(function(err, data) {
        if (err) {
          if (config.verbose) {
            console.error('Error while attaching file: ' + file + ' to ' + doc.path);
          }
          callback(err);
          return;
        }

        // successfully attached blob
        if (config.verbose) {
          console.log('Attached blob to: ' + doc.path);
        }
        callback(null, doc, metadata);
      });
    });
  };

  var createFolder = function(dir, remotePath, callback) {
    if (config.verbose) {
      console.log('Create folder: ' + dir);
    }

    var metadata = readFilename(path.basename(dir), true);

    client.document(remotePath)
      .create({
        type: metadata.type,
        name: metadata.filename,
        properties: metadata.properties
      }, function(err, doc) {
        if (err) {
          callback(err, dir, metadata);
        } else {
          if (config.verbose) {
            console.log('Created remote folder: ' + doc.path);
          }

          callback(null, doc, metadata);
        }
      });
  };

  var followTransition = function(doc, metadata, callback) {
    if (!metadata.transition) {
      if (config.verbose) {
        console.log('Not following transition for: ' + doc.path);
      }

      callback(null, doc, metadata);
      return;
    }

    if (config.verbose) {
      console.log('Following transition for: ' + doc.path);
    }

    var operation = client.operation('Document.SetLifeCycle')
      .param('value', metadata.transition)
      .input(doc.uid);

    operation.execute(function(err, updatedDoc, response) {
      if (err) {
        if (config.verbose) {
          console.error('Error while following transition ' + metadata.transition + ' on doc ' + doc.path);
        }
        callback(err);
        return;
      }

      if (config.verbose) {
        console.log('Followed transition  ' + metadata.transition + ' on doc ' + updatedDoc.path);
      }

      callback(null, updatedDoc, metadata);
    });
  };

  var setACE = function(doc, metadata, callback) {
    if (metadata.lifecycleState !== 'obsolete') {
      if (config.verbose) {
        console.log('Not setting ACE for: ' + doc.path);
      }

      callback(null, doc, metadata);
      return;
    }

    if (config.verbose) {
      console.log('Setting ACE for: ' + doc.path);
    }

    var operation = client.operation('Document.SetACE')
      .param('user', 'quality')
      .param('permission', 'Read')
      .input(doc.uid);

    operation.execute(function(err, updatedDoc, response) {
      if (err) {
        if (config.verbose) {
          console.error('Error while setting Read ACE for "quality" group on doc ' + doc.path);
        }
        callback(err);
        return;
      }

      if (config.verbose) {
        console.log('Setted Read ACE for "quality" group on doc ' + updatedDoc.path);
      }

      callback(null, updatedDoc, metadata);
    });
  }

  // for the final report
  var filesCount = 0,
    foldersCount = 0,
    filesCreated = 0,
    foldersCreated = 0,
    filesNotWellProcessed = [],
    foldersNotWellProcessed = [];

  // our queue to process documents creation
  var queue = async.queue(function(task, queueCallback) {
    if (config.verbose) {
      console.log('Started task for: ' + task.absPath);
    }

    var isDirectory = fs.statSync(task.absPath).isDirectory();
    var funcs = [];
    if (isDirectory) {
      funcs.push(createFolder.bind(this, task.absPath, task.remotePath));
      foldersCount++;
    } else {
      funcs = funcs.concat([
        createDocumentFromFile.bind(this, task.absPath, task.remotePath),
        uploadBlob
      ]);
      filesCount++;
    }
    funcs = funcs.concat([
      followTransition,
      setACE
    ]);

    async.waterfall(funcs, function(err, doc, metadata) {
      if (err) {
        if (isDirectory) {
          foldersNotWellProcessed.push({
            path: task.absPath,
            err: err
          });
        } else {
          filesNotWellProcessed.push({
            path: task.absPath,
            err: err
          });
        }

        if (config.verbose) {
          console.log('Taks in error for: ' + task.absPath);
        }
        queueCallback(); // next task
        return;
      }

      if (config.verbose) {
        console.log('Finished task for: ' + task.absPath);
      }

      queueCallback();
      if (isDirectory) {
        foldersCreated++;
        walk(task.absPath, doc.path);
      } else {
        filesCreated++;
      }
    });
  }, config.maxConcurrentRequests);

  // walk the whole directory tree
  var walk = function(localPath, remotePath) {
    fs.readdir(localPath, function(err, files) {
      if (fs.statSync(localPath).isFile()) {
        queue.push({
          absPath: localPath,
          remotePath: remotePath
        });
      } else {
        fs.readdir(localPath, function(err, files) {
          files.forEach(function(file) {
            var absPath = path.join(localPath, file);
            queue.push({
              absPath: absPath,
              remotePath: remotePath
            });
          });
        });
      }
    });
  };

  var start = new Date();
  walk(localPath, config.remotePath);

  process.on('exit', function() {
    var end = new Date();

    console.log('');
    console.log('Report Summary');
    console.log('--------------');
    console.log('  Total documents processed   ' + (foldersCreated + filesCreated) + '/' + (foldersCount + filesCount));
    console.log('    Files processed           ' + filesCreated + '/' + filesCount);
    console.log('    Folders processed         ' + foldersCreated + '/' + foldersCount);
    console.log('  Total time                  ' + (end - start) + 'ms');
    console.log('  Average time per document   ' + ((end - start) / (foldersCreated + filesCreated)) + 'ms');
    console.log('');
    if (filesNotWellProcessed.length > 0) {
      console.log('Files not well processed');
      console.log('------------------------');
      filesNotWellProcessed.forEach(function(file) {
        console.log(file.path);
        console.log('  Reason: ' + file.err.message);
        if (config.verbose) {
          console.log('  Error');
          console.log(JSON.stringify(file.err, null, 2));
        }
        console.log('');
      });
    }
    if (foldersNotWellProcessed.length > 0) {
      console.log('Folders not well processed');
      console.log('--------------------------');
      foldersNotWellProcessed.forEach(function(folder) {
        console.log(folder.path);
        console.log('  Reason: ' + folder.err.message);
        if (config.verbose) {
          console.log('  Error');
          console.log('  ' + JSON.stringify(folder.err, null, 2));
        }
        console.log('');
      });
    }
    console.log('');
  });
};
