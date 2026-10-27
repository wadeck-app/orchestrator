'use strict';

// A child whose argv is the answer: what the shell really handed to a program, quotes and spaces included.
process.stdout.write(JSON.stringify(process.argv.slice(2)));
