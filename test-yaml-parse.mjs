import { load } from 'js-yaml';
const yaml = `
\$brains:
  submitJob:
    \$brain: \$brains.\$http.post
    url: POST /api/jobs
    body: \$outputs.jobForm.onSubmit
    \$outputs: [id]
  navigateAfterCreate:
    \$brain: \$brains.\$ctx.navigate
    to: /jobs/{id}
    id: \$brains.submitJob.id
`;
const doc = load(yaml);
console.log(JSON.stringify(doc, null, 2));
