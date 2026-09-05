import React from 'react';
import { useParams } from 'react-router-dom';
import { GenericPageRunner } from '@wadeck-app/dsl-renderer';
import type { GenericPageRunnerProps } from '@wadeck-app/dsl-renderer';

type Props = Omit<GenericPageRunnerProps, 'key'> & { baseKey: string };

export function KeyedPageRunner(props: Props): React.ReactElement {
  const params = useParams();
  const paramSuffix = Object.values(params).filter(Boolean).join('/');
  const key = paramSuffix ? `${props.baseKey}/${paramSuffix}` : props.baseKey;
  return <GenericPageRunner key={key} yamlText={props.yamlText} registry={props.registry} fetcher={props.fetcher} />;
}
